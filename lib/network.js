import os from 'node:os';
import dns from 'node:dns';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const dnsReverse = promisify(dns.reverse);
const execAsync = promisify(exec);

const IS_WIN = process.platform === 'win32';

// interfaces virtuais/criadas por container que NAO devem ser tratadas como
// "a LAN" (comum aparecerem junto com a real quando o app roda com
// network_mode: host, ja que ai ele enxerga TODAS as interfaces do host,
// inclusive as que o proprio Docker cria)
const VIRTUAL_IFACE_RE = /^(docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|zt|wg|podman|cni|flannel|lxcbr|kube)/i;

function isVirtualIface(name) {
  // NETWORK_IFACE permite forcar manualmente qual interface usar (ex: eth0),
  // ignorando a heuristica acima — util se ela errar no seu ambiente.
  const forced = process.env.NETWORK_IFACE;
  if (forced) return name !== forced;
  return VIRTUAL_IFACE_RE.test(name);
}

// ---------- helpers de IP ----------

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function intToIp(int) {
  return [24, 16, 8, 0].map((shift) => (int >>> shift) & 255).join('.');
}

/**
 * Detecta os subnets IPv4 locais (nao-internos) a partir das interfaces de rede
 * do sistema operacional. Retorna { name, address, netmask, cidr, network, broadcast, hostCount }
 */
export function getLocalSubnets() {
  const ifaces = os.networkInterfaces();
  const subnets = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || isVirtualIface(name)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;

      const ipInt = ipToInt(addr.address);
      const maskInt = ipToInt(addr.netmask);
      const networkInt = (ipInt & maskInt) >>> 0;
      const broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;
      const hostCount = broadcastInt - networkInt - 1;

      // ignora mascaras absurdamente grandes (ex: /0) para nao tentar varrer o mundo
      if (hostCount <= 0 || hostCount > 4094) continue;

      subnets.push({
        iface: name,
        address: addr.address,
        netmask: addr.netmask,
        cidr: addr.cidr,
        network: intToIp(networkInt),
        broadcast: intToIp(broadcastInt),
        networkInt,
        broadcastInt,
        hostCount,
      });
    }
  }

  return subnets;
}

/**
 * Gera a lista de IPs de host dentro de um subnet (exclui rede e broadcast),
 * limitada a maxHosts para evitar varreduras gigantes.
 */
export function listHostIps(subnet, maxHosts = 512) {
  const ips = [];
  const start = subnet.networkInt + 1;
  const end = subnet.broadcastInt - 1;
  for (let i = start; i <= end && ips.length < maxHosts; i++) {
    ips.push(intToIp(i));
  }
  return ips;
}

/**
 * Retorna os enderecos MAC das interfaces de rede locais (nao-internas) da
 * propria maquina onde o app esta rodando, uma por interface IPv4 ativa.
 */
export function getLocalMacAddresses() {
  const ifaces = os.networkInterfaces();
  const seen = new Set();
  const macs = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || isVirtualIface(name)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (!addr.mac || addr.mac === '00:00:00:00:00:00') continue;

      const mac = addr.mac.toUpperCase();
      if (seen.has(mac)) continue;
      seen.add(mac);

      macs.push({ iface: name, mac, ip: addr.address });
    }
  }

  return macs;
}

// ---------- ping ----------

function pingOnce(ip, timeoutMs = 400) {
  const cmd = IS_WIN
    ? `ping -n 1 -w ${timeoutMs} ${ip}`
    : `ping -c 1 -W ${Math.max(1, Math.round(timeoutMs / 1000))} ${ip}`;

  return execAsync(cmd, { windowsHide: true })
    .then(({ stdout }) => {
      if (IS_WIN) {
        // "Esgotado o tempo limite" / "Destination host unreachable" contam como falha
        return /TTL=/i.test(stdout);
      }
      return /(\d) received/.test(stdout) && !/0 received/.test(stdout);
    })
    .catch(() => false);
}

/**
 * Faz ping em varios IPs com concorrencia limitada, apenas para popular a
 * tabela ARP do sistema operacional (nao usamos o resultado diretamente,
 * so o efeito colateral de o host responder e o SO cachear o MAC).
 */
export async function pingSweep(ips, concurrency = 40) {
  let index = 0;
  const results = new Map();

  async function worker() {
    while (index < ips.length) {
      const i = index++;
      const ip = ips[i];
      const alive = await pingOnce(ip);
      results.set(ip, alive);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, ips.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------- tabela ARP ----------

const MAC_RE = /([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/;
const IP_RE = /((?:\d{1,3}\.){3}\d{1,3})/;

function normalizeMac(mac) {
  return mac.replace(/-/g, ':').toUpperCase();
}

/**
 * Le a tabela ARP do sistema operacional e retorna [{ ip, mac }]
 * ignorando entradas de broadcast/multicast/invalidas.
 */
export async function getArpTable() {
  const cmd = IS_WIN ? 'arp -a' : 'arp -na';
  const { stdout } = await execAsync(cmd, { windowsHide: true });

  const entries = [];
  for (const line of stdout.split(/\r?\n/)) {
    const macMatch = line.match(MAC_RE);
    const ipMatch = line.match(IP_RE);
    if (!macMatch || !ipMatch) continue;

    const mac = normalizeMac(macMatch[0]);
    const ip = ipMatch[1];

    if (mac === 'FF:FF:FF:FF:FF:FF') continue; // broadcast
    if (mac.startsWith('01:00:5E')) continue; // multicast
    if (mac === '00:00:00:00:00:00') continue;

    entries.push({ ip, mac });
  }
  return entries;
}

/**
 * Tenta resolver o hostname via DNS reverso, com timeout curto. Falha silenciosa.
 */
export async function reverseDnsSafe(ip, timeoutMs = 300) {
  return Promise.race([
    dnsReverse(ip).then((names) => names?.[0] ?? null).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

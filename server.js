import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLocalSubnets, listHostIps, pingSweep, getArpTable, reverseDnsSafe, getLocalMacAddresses } from './lib/network.js';
import { sendMagicPacket, isValidMac } from './lib/wake.js';
import * as store from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let scanning = false;

// -------- rede / diagnostico --------

app.get('/api/network', (req, res) => {
  res.json({ subnets: getLocalSubnets() });
});

// -------- dispositivos --------

app.get('/api/devices', async (req, res) => {
  res.json(await store.listDevices());
});

app.post('/api/devices', async (req, res) => {
  const { name, mac, ip } = req.body || {};
  if (!isValidMac(mac)) {
    return res.status(400).json({ error: 'MAC invalido. Use o formato AA:BB:CC:DD:EE:FF.' });
  }
  const device = {
    id: store.newId(),
    name: (name && name.trim()) || mac,
    mac: mac.trim().toUpperCase().replace(/-/g, ':'),
    ip: ip || null,
    hostname: null,
    online: false,
    lastSeen: null,
    addedAt: new Date().toISOString(),
    manual: true,
  };
  await store.saveDevice(device);
  res.status(201).json(device);
});

app.put('/api/devices/:id', async (req, res) => {
  const { name, ip, mac } = req.body || {};
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (ip !== undefined) patch.ip = ip;
  if (mac !== undefined) {
    if (!isValidMac(mac)) return res.status(400).json({ error: 'MAC invalido.' });
    patch.mac = mac.trim().toUpperCase().replace(/-/g, ':');
  }
  const updated = await store.updateDevice(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'Dispositivo nao encontrado.' });
  res.json(updated);
});

app.delete('/api/devices/:id', async (req, res) => {
  const ok = await store.deleteDevice(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Dispositivo nao encontrado.' });
  res.status(204).end();
});

// -------- varredura da rede --------

app.post('/api/scan', async (req, res) => {
  if (scanning) {
    return res.status(409).json({ error: 'Ja existe uma varredura em andamento.' });
  }
  scanning = true;
  try {
    const subnets = getLocalSubnets();
    if (subnets.length === 0) {
      return res.status(500).json({ error: 'Nenhuma interface de rede local (IPv4) foi encontrada.' });
    }

    // varre todos os subnets locais detectados
    const allIps = subnets.flatMap((s) => listHostIps(s));
    await pingSweep(allIps);

    const arpEntries = await getArpTable();

    // resolve hostname (best-effort, em paralelo, com timeout curto por item)
    const withHostnames = await Promise.all(
      arpEntries.map(async (e) => ({ ...e, hostname: await reverseDnsSafe(e.ip) }))
    );

    await store.mergeScanResults(withHostnames);
    // garante que os MACs da propria maquina continuem na lista e online
    const devices = await store.upsertSelfDevices(getLocalMacAddresses());
    res.json({ subnets, found: withHostnames.length, devices });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Falha ao varrer a rede.', detail: String(err.message || err) });
  } finally {
    scanning = false;
  }
});

app.get('/api/scan/status', (req, res) => {
  res.json({ scanning });
});

// -------- wake on lan --------

app.post('/api/wake/:id', async (req, res) => {
  const devices = await store.listDevices();
  const device = devices.find((d) => d.id === req.params.id);
  if (!device) return res.status(404).json({ error: 'Dispositivo nao encontrado.' });

  try {
    const subnets = getLocalSubnets();
    const broadcast = subnets[0]?.broadcast || '255.255.255.255';
    await sendMagicPacket(device.mac, { address: broadcast });
    // tenta tambem o broadcast global, caso o dispositivo esteja em outro subnet roteavel
    if (broadcast !== '255.255.255.255') {
      await sendMagicPacket(device.mac, { address: '255.255.255.255' }).catch(() => {});
    }
    res.json({ ok: true, mac: device.mac, broadcast });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao enviar magic packet.', detail: String(err.message || err) });
  }
});

app.post('/api/wake-mac/:mac', async (req, res) => {
  const { mac } = req.params;
  if (!isValidMac(mac)) return res.status(400).json({ error: 'MAC invalido.' });
  try {
    const subnets = getLocalSubnets();
    const broadcast = subnets[0]?.broadcast || '255.255.255.255';
    await sendMagicPacket(mac, { address: broadcast });
    res.json({ ok: true, mac, broadcast });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao enviar magic packet.', detail: String(err.message || err) });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// registra os MACs da propria maquina assim que o servidor sobe, para
// que ja apareçam na lista mesmo antes do primeiro scan
await store.upsertSelfDevices(getLocalMacAddresses());

app.listen(PORT, () => {
  console.log(`WoL Auto rodando em http://localhost:${PORT}`);
  console.log('Subnets locais detectados:', getLocalSubnets().map((s) => s.cidr));
});

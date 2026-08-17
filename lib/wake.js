import dgram from 'node:dgram';

const MAC_RE = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;

export function isValidMac(mac) {
  return typeof mac === 'string' && MAC_RE.test(mac.trim());
}

function macToBytes(mac) {
  return Buffer.from(mac.trim().replace(/-/g, ':').split(':').map((b) => parseInt(b, 16)));
}

function buildMagicPacket(mac) {
  const macBytes = macToBytes(mac);
  const header = Buffer.alloc(6, 0xff);
  return Buffer.concat([header, Buffer.concat(Array(16).fill(macBytes))]);
}

/**
 * Envia o magic packet de Wake on LAN via broadcast UDP.
 * @param {string} mac endereco MAC do dispositivo alvo
 * @param {object} opts { address broadcast, port }
 */
export function sendMagicPacket(mac, { address = '255.255.255.255', port = 9 } = {}) {
  return new Promise((resolve, reject) => {
    if (!isValidMac(mac)) {
      reject(new Error(`MAC invalido: ${mac}`));
      return;
    }

    const packet = buildMagicPacket(mac);
    const socket = dgram.createSocket('udp4');

    socket.on('error', (err) => {
      socket.close();
      reject(err);
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, address, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve(true);
      });
    });
  });
}

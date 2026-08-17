import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

// DATA_DIR permite apontar a persistencia para um volume montado (ex: em Docker)
const DATA_DIR = process.env.DATA_DIR || process.cwd();
const DB_PATH = path.join(DATA_DIR, 'devices.json');

async function readAll() {
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeAll(devices) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DB_PATH, JSON.stringify(devices, null, 2), 'utf8');
}

export async function listDevices() {
  return readAll();
}

export async function saveDevice(device) {
  const devices = await readAll();
  const idx = devices.findIndex((d) => d.id === device.id);
  if (idx >= 0) devices[idx] = device;
  else devices.push(device);
  await writeAll(devices);
  return device;
}

export async function updateDevice(id, patch) {
  const devices = await readAll();
  const idx = devices.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  devices[idx] = { ...devices[idx], ...patch };
  await writeAll(devices);
  return devices[idx];
}

export async function deleteDevice(id) {
  const devices = await readAll();
  const next = devices.filter((d) => d.id !== id);
  await writeAll(next);
  return next.length !== devices.length;
}

export function newId() {
  return crypto.randomUUID();
}

/**
 * Garante que os MACs da propria maquina (onde o app roda) estejam sempre
 * presentes na lista, marcados com self:true e online:true. Preserva nome
 * customizado se o usuario ja tiver renomeado.
 */
export async function upsertSelfDevices(localMacs) {
  const devices = await readAll();
  const byMac = new Map(devices.map((d) => [d.mac, d]));
  const now = new Date().toISOString();
  const hostname = os.hostname();

  for (const item of localMacs) {
    const existing = byMac.get(item.mac);
    if (existing) {
      existing.ip = item.ip;
      existing.online = true;
      existing.self = true;
      existing.lastSeen = now;
      if (!existing.hostname) existing.hostname = hostname;
    } else {
      const device = {
        id: newId(),
        name: hostname ? `${hostname} (este dispositivo)` : 'Este dispositivo',
        mac: item.mac,
        ip: item.ip,
        hostname,
        online: true,
        lastSeen: now,
        addedAt: now,
        manual: false,
        self: true,
      };
      devices.push(device);
      byMac.set(item.mac, device);
    }
  }

  await writeAll(devices);
  return devices;
}

/**
 * Mescla os resultados de uma varredura (lista de {ip, mac, hostname}) com o
 * que ja esta persistido, por MAC. Dispositivos existentes sao atualizados
 * (ip/hostname/online/lastSeen); dispositivos novos sao criados; dispositivos
 * conhecidos que nao apareceram na varredura ficam marcados offline, mas
 * continuam salvos (o MAC ainda pode ser usado para acordar via WoL).
 */
export async function mergeScanResults(found) {
  const devices = await readAll();
  const byMac = new Map(devices.map((d) => [d.mac, d]));
  const now = new Date().toISOString();
  const foundMacs = new Set();

  for (const item of found) {
    foundMacs.add(item.mac);
    const existing = byMac.get(item.mac);
    if (existing) {
      existing.ip = item.ip;
      existing.hostname = item.hostname || existing.hostname || null;
      existing.online = true;
      existing.lastSeen = now;
    } else {
      const device = {
        id: newId(),
        name: item.hostname || item.ip,
        mac: item.mac,
        ip: item.ip,
        hostname: item.hostname || null,
        online: true,
        lastSeen: now,
        addedAt: now,
        manual: false,
      };
      devices.push(device);
      byMac.set(item.mac, device);
    }
  }

  for (const d of devices) {
    if (!foundMacs.has(d.mac)) d.online = false;
  }

  await writeAll(devices);
  return devices;
}

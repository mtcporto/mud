import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(address, prefix);

export function isPublicIPv4(address) {
  return isIP(address) === 4 && !blocked.check(address);
}

export async function resolvePublicTarget(host) {
  // Resolve once and connect to that vetted IP, preventing DNS rebinding.
  const addresses = await lookup(host, { family: 4, all: true });
  if (!addresses.length || addresses.some(item => !isPublicIPv4(item.address))) throw new Error('Destination is not permitted');
  return addresses[0].address;
}

export function parseTargets(raw) {
  const targets = raw ? JSON.parse(raw) : [{ id: 'fatal', name: 'Fatal Dimensions', host: 'mud.fataldimensions.nl', port: 4000, encoding: 'utf-8' }];
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 20) throw new Error('Configure between 1 and 20 MUD targets');
  const ids = new Set();
  for (const t of targets) {
    if (!/^[a-z0-9-]{1,32}$/.test(t.id) || ids.has(t.id) || typeof t.name !== 'string' || t.name.length > 80 || typeof t.host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(t.host) || !Number.isInteger(t.port) || t.port < 1 || t.port > 65535 || !['utf-8','windows-1252'].includes(t.encoding || 'utf-8')) throw new Error('Invalid MUD target');
    ids.add(t.id);
  }
  return targets;
}

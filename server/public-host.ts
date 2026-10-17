import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// Address ranges a pasted link must never reach from this host. Cloudflare
// Workers cannot reach private networks; a Node process resolving DNS itself can.
const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** True only when every address the name resolves to is public. A later
 * re-resolution can still differ (DNS rebinding); this host is for local use. */
export async function isPublicHost(hostname: string): Promise<boolean> {
  if (isIP(hostname)) return false;
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.length > 0 && addresses.every(({ address, family }) => !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4'));
}

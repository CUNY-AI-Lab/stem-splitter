import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

// Cloudflare Workers cannot reach private networks; a Node process resolving
// DNS itself can, so the Node host's link import connects only to public addresses.
const blocked4 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  blocked4.addSubnet(network, prefix, 'ipv4');
}
// IPv6: only global unicast, minus ranges that embed or tunnel another address.
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new BlockList();
for (const [network, prefix] of [['2001::', 32], ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16]] as const) {
  blocked6.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) return !blocked4.check(address, 'ipv4');
  return global6.check(address, 'ipv6') && !blocked6.check(address, 'ipv6');
}

/** Used as the socket's own resolver, so the address checked here is the one
 * connected to; a second resolution cannot swap in a private address. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) { callback(error, '', 0); return; }
    const list = addresses as LookupAddress[];
    if (!list.length || !list.every(({ address, family }) => isPublicAddress(address, family))) {
      callback(Object.assign(new Error(`Refusing a non-public address for ${hostname}`), { code: 'EADDRNOTPUBLIC' }), '', 0);
      return;
    }
    if ((options as { all?: boolean }).all) (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

/** GET over HTTPS that never follows redirects and connects only to public addresses. */
export function publicOnlyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || isIP(target.hostname.replace(/^\[|\]$/g, ''))) {
      reject(new TypeError('Only public HTTPS host names can be fetched.'));
      return;
    }
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const outgoing = request(target, { method: 'GET', headers, lookup: publicLookup, signal: init.signal ?? undefined }, incoming => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) for (const item of [value].flat()) responseHeaders.append(name, String(item));
      }
      const status = incoming.statusCode ?? 502;
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, headers: responseHeaders }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Disposable loopback HTTPS preserves real Secure/__Host- cookie transport.
export async function fixtureFetch(server, request) {
  return server.fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
    ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.arrayBuffer() } : {}) });
}
export async function localHttpsFixture(handler) {
  const directory = await mkdtemp(join(tmpdir(), 'stem-account-browser-'));
  let server, origin;
  const errors = [], pending = new Set();
  try {
    const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, outgoing) => {
      const task = (async () => { try {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const request = new Request(new URL(incoming.url, origin), { method: incoming.method, headers,
          ...(body.length ? { body } : {}) });
        const response = await handler(request);
        const responseBody = Buffer.from(await response.arrayBuffer());
        if (outgoing.destroyed) return;
        for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
        const cookies = response.headers.getSetCookie();
        if (cookies.length) outgoing.setHeader('set-cookie', cookies);
        outgoing.writeHead(response.status); outgoing.end(responseBody);
      } catch (error) {
        errors.push(error.message);
        if (!outgoing.destroyed) {
          if (!outgoing.headersSent) outgoing.writeHead(500);
          outgoing.end('Local fixture request failed');
        }
      } })();
      pending.add(task); void task.finally(() => pending.delete(task));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `https://127.0.0.1:${server.address().port}`;
    return { origin, errors, async close() {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await Promise.all(pending);
      await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) {
    server?.closeAllConnections(); server?.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}

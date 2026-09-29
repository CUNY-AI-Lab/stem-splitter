import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Cloudflare production and Workerd tests use the same patched framework', () => {
  const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const production = read('./wrangler.jsonc');
  const fixture = read('./test-wrangler.jsonc');
  const packages = read('./package.json');
  assert.deepEqual(production.alias, { hono: 'hono-cloudflare', 'hono/factory': 'hono-cloudflare/factory' });
  assert.deepEqual(fixture.alias, production.alias);
  assert.equal(packages.dependencies['hono-cloudflare'], 'npm:hono@4.13.11');
  assert.equal(read('./node_modules/hono-cloudflare/package.json').version, '4.13.11');
});

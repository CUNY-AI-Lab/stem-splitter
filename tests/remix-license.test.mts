import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const context: any = { URL };
runInNewContext(readFileSync(new URL('../public/remix-license.js', import.meta.url), 'utf8'), context);
const { resolve, parseLicense } = context.StemRemixLicense;
const source = (type: string) => ({ licenseUrl: `https://creativecommons.org/licenses/${type}/4.0/` });
test('remix export enforces ShareAlike and NonCommercial compatibility', () => {
  assert.equal(resolve([source('by-sa'), source('by-nc')]).allowed, false);
  assert.equal(resolve([source('by-sa'), source('by-nc-sa')]).allowed, false);
  assert.equal(resolve([source('by'), source('by-sa')]).licenseUrl, source('by-sa').licenseUrl);
  assert.equal(resolve([source('by'), source('by-nc-sa')]).nonCommercial, true);
});
test('missing, ND, deceptive-host, and unreviewed version licenses block export', () => {
  for (const value of [null, source('by-nd'), source('by-nc-nd'), { licenseUrl: 'https://creativecommons.org.evil.test/licenses/by/4.0/' }, { licenseUrl: 'https://creativecommons.org/licenses/by-sa/1.0/' }]) {
    assert.equal(resolve([value]).allowed, false);
  }
  assert.equal(parseLicense('https://creativecommons.org/publicdomain/zero/1.0/'), 'pd');
  assert.equal(resolve([]).allowed, false);
});

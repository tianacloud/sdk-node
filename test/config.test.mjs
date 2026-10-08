import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '../src/index.js';
import { ENDPOINT, ENDPOINT_ID, TOKEN } from './support.mjs';

test('complete endpoint hostnames retain deployment suffix and endpoint identity', () => {
  const authority = JSON.parse(readFileSync(new URL('fixtures/public-connect-authority-v1.json', import.meta.url)));
  for (const suffix of authority.endpoint_suffixes) {
    const host = ENDPOINT_ID + suffix;
    for (const endpoint of [host, host.toUpperCase(), `${host}:443`]) {
      const client = new Client({ endpoint });
      assert.equal(client.endpoint, host);
      client.close();
    }
  }
  assert.equal(authority.default_port, 443);
  for (const endpoint of [
    '', `${ENDPOINT}:8443`, `${ENDPOINT}:0443`, `${ENDPOINT}.`, `https://${ENDPOINT}`,
    `${ENDPOINT}/x`, `${ENDPOINT}?x`, 'ep-81j5c9m7q2v8x4k6n3r0t1w2yz.tianacloud.com',
    'ep-01j5c9m7q2v8x4k6n3r0t1w2yi.tianacloud.com', ENDPOINT_ID,
    `${ENDPOINT_ID}..example.test`, `${ENDPOINT_ID}.-invalid.test`,
  ]) assert.throws(() => new Client({ endpoint }), { code: 'INVALID_CONFIGURATION' });
});

test('invalid tokens, trust roots, protocols and configuration fail locally', async () => {
  for (const token of ['', TOKEN + '\n', ' leading', 'trailing ', 'a\tb', 'a\0b', 'a\x7fb', 'é', 'x'.repeat(4097), null, 42]) {
    assert.throws(() => new Client({ endpoint: ENDPOINT, token }), { code: 'INVALID_CONFIGURATION' });
  }
  for (const options of [
    { ca: [] }, { ca: 'not a certificate' }, { gateway: { host: '127.0.0.1', port: 0 } },
    { gateway: { host: 'https://localhost', port: 443 } }, { connectTimeoutMs: 0 },
    { responseTimeoutMs: NaN },
  ]) assert.throws(() => new Client({ endpoint: ENDPOINT, ...options }), { code: 'INVALID_CONFIGURATION' });
  const client = new Client({ endpoint: ENDPOINT, token: TOKEN });
  for (const protocol of ['', 'a'.repeat(65), 'a b', 'x\n', 'x\r', 'é', 'x/y', undefined, 42]) {
    await assert.rejects(client.connect(protocol), { code: 'INVALID_CONFIGURATION' });
  }
  await assert.rejects(client.connect('echo-stream', { signal: {} }), { code: 'INVALID_CONFIGURATION' });
  client.close();
});


test('opaque credentials accept new versions and formats without normalization', () => {
  for (const token of [TOKEN, `tia_1${'A'.repeat(43)}`, 'session.other-format_+/==',
    'tia_noncanonical', '!', 'x'.repeat(4096)]) {
    const client = new Client({ endpoint: ENDPOINT, token });
    client.close();
  }
});

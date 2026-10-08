import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client, GatewayError } from '../src/index.js';

const root = process.argv[2] ?? process.env.TIANA_GATEWAY_FIXTURE;
if (!root) throw new Error('Pass the Gateway fixture directory');
const ready = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8'));
const ca = readFileSync(join(root, 'fixtures/gateway.pem'));
const token = readFileSync(join(root, 'fixtures/synthetic-token.txt'), 'utf8').trim();
const result = { gatewayCommit: ready.gateway_commit, successes: [], refusals: [], cancelled: false };
const options = address => {
  const [host, port] = address.split(':');
  return { endpoint: ready.endpoint, ca, gateway: { host, port: Number(port) } };
};
for (const [name, address, credential] of [
  ['anonymous', ready.anonymous_address, undefined],
  ['token', ready.token_address, token],
]) {
  const client = new Client({ ...options(address), token: credential });
  try {
    const tunnel = await client.connect(process.env.TIANA_PROTOCOL, { signal: AbortSignal.timeout(10_000) });
    const payload = Buffer.alloc(1024 * 1024, 99);
    const read = (async () => {
      const chunks = [];
      for await (const chunk of tunnel) chunks.push(chunk);
      return Buffer.concat(chunks);
    })();
    tunnel.end(payload);
    assert.deepEqual(await read, Buffer.concat([Buffer.from(ready.greeting), payload, Buffer.from(ready.eof_tail)]));
    result.successes.push({ name, authMode: tunnel.authMode, bytes: payload.length, halfClose: true });
  } finally { client.close(); }
}
for (const [address, credential, status, code] of [
  [ready.token_address, undefined, 407, 'AUTH_REQUIRED'],
  [ready.token_address, `tia_0${Buffer.alloc(32, 99).toString('base64url')}`, 407, 'ACCESS_DENIED'],
  [ready.POLICY_UNAVAILABLE, undefined, 503, 'POLICY_UNAVAILABLE'],
]) {
  const client = new Client({ ...options(address), token: credential });
  try {
    await assert.rejects(client.connect(process.env.TIANA_PROTOCOL), error => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.status, status);
      assert.equal(error.gatewayCode, code);
      assert.equal(error.retryable, status === 503);
      result.refusals.push({ status, code, retryable: error.retryable });
      return true;
    });
  } finally { client.close(); }
}
const client = new Client(options(ready.anonymous_address));
try {
  const abort = new AbortController();
  const tunnel = await client.connect(process.env.TIANA_PROTOCOL, { signal: abort.signal });
  const errorEvent = once(tunnel, 'error');
  abort.abort();
  const [error] = await errorEvent;
  assert.equal(error.code, 'ABORT_ERR');
  assert.equal(error.outcomeUnknown, true);
  result.cancelled = true;
} finally { client.close(); }
process.stdout.write(JSON.stringify(result, null, 2) + '\n');

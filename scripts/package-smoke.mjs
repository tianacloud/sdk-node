import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateway, success, fixture, TOKEN } from '../test/support.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(root, '.artifacts');
mkdirSync(artifacts, { recursive: true });
const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', artifacts, '--cache', join(artifacts, 'npm-cache')], { cwd: root, encoding: 'utf8' }))[0];
for (const file of pack.files) assert.match(file.path, /^(src\/|examples\/|README\.md$|LICENSE$|package\.json$)/);
const consumer = mkdtempSync(join(artifacts, 'consumer-'));
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
execFileSync('npm', ['install', join(artifacts, pack.filename), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', join(artifacts, 'npm-cache')], { cwd: consumer, stdio: 'pipe' });
writeFileSync(join(consumer, 'types.mts'), readFileSync(join(root, 'test/types/consumer.mts')));
execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc')),
  '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--noEmit',
  join(consumer, 'types.mts'),
], { cwd: consumer, stdio: 'pipe' });
const cleanup = [];
const g = await gateway({ after: fn => cleanup.push(fn) }, (stream, headers) => {
  if (headers['proxy-authorization']) assert.equal(headers['proxy-authorization'], `Bearer ${TOKEN}`);
  success(stream, headers, { 'tiana-auth-mode': headers['proxy-authorization'] ? 'TOKEN_REQUIRED' : 'DISABLED' });
  stream.on('data', chunk => stream.write(chunk));
  stream.on('end', () => stream.end());
});
writeFileSync(join(consumer, 'ca.pem'), fixture('endpoint-cert'));
writeFileSync(join(consumer, 'consume.mjs'), `
import { Client } from '@tiana/node';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const client = new Client({ endpoint: process.env.TIANA_ENDPOINT, ca: readFileSync('ca.pem'),
  gateway: { host: '127.0.0.1', port: Number(process.env.TIANA_GATEWAY_ADDRESS.split(':').at(-1)) } });
try {
  const tunnel = await client.connect('echo-stream');
  tunnel.end('installed-consumer');
  const chunks = [];
  for await (const chunk of tunnel) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'installed-consumer');
} finally { client.close(); }
`);
try {
  const env = { ...process.env, TIANA_PROTOCOL: 'echo-stream', TIANA_ENDPOINT: g.options.endpoint, TIANA_GATEWAY_ADDRESS: `127.0.0.1:${g.options.gateway.port}`, TIANA_CA_FILE: join(consumer, 'ca.pem') };
  delete env.TIANA_TOKEN;
  // Retired inputs must not override the new address, even when malformed.
  env.TIANA_DIAL_ADDRESS = 'invalid-removed-address';
  env.TIANA_GATEWAY_HOST = 'invalid-removed-host';
  env.TIANA_GATEWAY_PORT = 'invalid-removed-port';
  await run(process.execPath, ['consume.mjs'], { cwd: consumer, env, timeout: 5000 });
  const example = join(consumer, 'node_modules/@tiana/node/examples/tunnel.mjs');
  env.TIANA_TOKEN = TOKEN;
  env.TIANA_TOKEN_FILE = join(consumer, 'nonexistent-token-file');
  const child = execFile(process.execPath, [example], { cwd: consumer, env, timeout: 5000, encoding: 'buffer' });
  const output = new Promise((resolveOutput, reject) => {
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveOutput(Buffer.concat(chunks)) : reject(new Error('Example failed')));
  });
  child.stdin.end('installed-example');
  assert.equal((await output).toString(), 'installed-example');
  assert.equal(g.observations.at(-1).headers['proxy-authorization'], `Bearer ${TOKEN}`);
  const cancelled = execFile(process.execPath, [example], {
    cwd: consumer, env, timeout: 5000, killSignal: 'SIGKILL', encoding: 'buffer',
  });
  const closed = once(cancelled, 'close');
  const diagnostics = [];
  cancelled.stderr.on('data', chunk => diagnostics.push(chunk));
  try {
    const echo = once(cancelled.stdout, 'data');
    // Keep stdin open while interrupting an established tunnel.
    cancelled.stdin.write('before-cancel');
    assert.equal((await echo)[0].toString(), 'before-cancel');
    cancelled.kill('SIGINT');
    const [code, signal] = await closed;
    assert.equal(code, 1);
    assert.equal(signal, null, 'one SIGINT must exit without a timeout kill');
    assert.match(Buffer.concat(diagnostics).toString(), /^ABORT_ERR \(tunnel\): outcome unknown\n$/);
  } finally {
    if (cancelled.exitCode === null && cancelled.signalCode === null) cancelled.kill('SIGKILL');
    await closed;
  }
  process.stdout.write(JSON.stringify({ package: pack.filename, consumer: resolve(consumer), packedFiles: pack.files.map(file => file.path), javascript: 'PASS', typescript: 'PASS', example: 'PASS', exampleCancellation: 'PASS' }, null, 2) + '\n');
} finally {
  for (const fn of cleanup) await fn();
}

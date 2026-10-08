import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import tls from 'node:tls';
import net from 'node:net';
import { once } from 'node:events';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, ConnectError, GatewayError } from '../src/index.js';
import { gateway, success, collect, fixture, ENDPOINT, ENDPOINT_ID, TOKEN } from './support.mjs';

test('one client artifact connects to online and staging complete hostnames', { timeout: 5000 }, async t => {
  const g = await gateway(t, (stream, headers, observation) => {
    observation.sni = stream.session.socket.servername;
    success(stream, headers);
    stream.on('data', chunk => stream.write(chunk));
    stream.on('end', () => stream.end());
  });
  for (const suffix of ['tianacloud.com', 'tianacloud-staging.net']) {
    const endpoint = `${ENDPOINT_ID}.${suffix}`;
    const client = new Client({ ...g.options, endpoint });
    try {
      const tunnel = await client.connect('hrana-http');
      const result = collect(tunnel);
      tunnel.end('same installed client');
      assert.equal((await result).toString(), 'same installed client');
      const observed = g.observations.at(-1);
      assert.equal(observed.sni, endpoint);
      assert.equal(observed.headers[':authority'], `${endpoint}:443`);
      assert.equal(observed.headers['proxy-authorization'], `Bearer ${TOKEN}`);
    } finally { client.close(); }
  }
});

test('TLS 1.3/h2, regular CONNECT, sensitive token, server-first and client half-close', { timeout: 5000 }, async t => {
  let received = 0;
  let preResponse = 0;
  const g = await gateway(t, (stream, headers, observation) => {
    observation.sni = stream.session.socket.servername;
    observation.alpn = stream.session.socket.alpnProtocol;
    observation.tls = stream.session.socket.getProtocol();
    stream.on('data', chunk => { received += chunk.length; stream.write(chunk); });
    setTimeout(() => {
      preResponse = received;
      success(stream, headers);
      stream.write('server-first:');
    }, 30);
    stream.on('end', () => stream.end(':after-eof'));
  });
  const client = new Client(g.options);
  t.after(() => client.close());
  const tunnel = await client.connect('echo-stream');
  const body = Buffer.alloc(2 * 1024 * 1024, 61);
  const result = collect(tunnel);
  assert.equal(tunnel.write(body), false, 'large write must expose backpressure');
  tunnel.end();
  assert.deepEqual(await result, Buffer.concat([Buffer.from('server-first:'), body, Buffer.from(':after-eof')]));
  const o = g.observations[0];
  assert.equal(o.sni, ENDPOINT);
  assert.equal(o.alpn, 'h2');
  assert.equal(o.tls, 'TLSv1.3');
  assert.equal(o.headers[':method'], 'CONNECT');
  assert.equal(o.headers[':authority'], `${ENDPOINT}:443`);
  assert.equal(o.headers[':path'], undefined);
  assert.equal(o.headers[':scheme'], undefined);
  assert.equal(o.headers[':protocol'], undefined);
  assert.equal(o.headers['tiana-tunnel-version'], '1');
  assert.equal(o.headers['tiana-database-protocol'], 'echo-stream');
  assert.match(o.headers['tiana-request-id'], /^req-[A-Za-z0-9_-]{24}$/);
  assert.equal(o.headers['proxy-authorization'], `Bearer ${TOKEN}`);
  assert.ok(o.headers[http2.sensitiveHeaders].includes('proxy-authorization'));
  assert.equal(o.session.remoteSettings.headerTableSize, 0);
  assert.equal(preResponse, 0);
  assert.equal(received, body.length);
  assert.equal(tunnel.destroyed, true);
});

test('remote END_STREAM leaves write direction open and anonymous token is omitted', { timeout: 5000 }, async t => {
  let resolveReceived;
  const received = new Promise(resolve => { resolveReceived = resolve; });
  const g = await gateway(t, (stream, headers) => {
    success(stream, headers, { 'tiana-auth-mode': 'DISABLED' });
    stream.end('greeting');
    collect(stream).then(resolveReceived);
  });
  const client = new Client({ ...g.options, token: undefined });
  t.after(() => client.close());
  const tunnel = await client.connect('echo-second');
  assert.equal((await collect(tunnel)).toString(), 'greeting');
  assert.equal(tunnel.writableEnded, false);
  tunnel.end('after-server-eof');
  assert.equal((await received).toString(), 'after-server-eof');
  assert.equal(g.observations[0].headers['proxy-authorization'], undefined);
});

test('slow reader preserves bytes beyond both HTTP/2 windows', { timeout: 8000 }, async t => {
  const payload = Buffer.alloc(3 * 1024 * 1024, 82);
  let serverFinished = false;
  const g = await gateway(t, (stream, headers) => {
    success(stream, headers);
    stream.end(payload, () => { serverFinished = true; });
    stream.resume();
  });
  const client = new Client(g.options);
  t.after(() => client.close());
  const tunnel = await client.connect('echo-stream');
  await delay(50);
  assert.equal(serverFinished, false, 'HTTP/2 flow control must stop the peer until read');
  tunnel.end();
  assert.deepEqual(await collect(tunnel), payload);
});

test('Gateway refusals expose bounded metadata without retry or remote text', { timeout: 8000 }, async t => {
  const cases = [
    [400, 'MALFORMED_CONNECT', undefined, false], [400, 'EARLY_TUNNEL_DATA', undefined, false],
    [407, 'AUTH_REQUIRED', undefined, false], [407, 'ACCESS_DENIED', undefined, false],
    [407, 'AUTHORIZATION_EXPIRED', undefined, false], [504, 'CALLER_DEADLINE', undefined, false],
    [421, 'ENDPOINT_MISMATCH', undefined, false], [429, 'CONNECTION_LIMIT', '100', true],
    [503, 'POLICY_UNAVAILABLE', '60000', true], [503, 'INSTANCE_UNAVAILABLE', '1', true],
    [504, 'ACTIVATION_TIMEOUT', '100', true], [503, 'AUTH_REQUIRED', '100', false],
    [503, 'POLICY_UNAVAILABLE', '60001', false], [503, 'POLICY_UNAVAILABLE', undefined, false],
    [500, TOKEN, undefined, false],
  ];
  for (const [status, code, hint, retryable] of cases) {
    const g = await gateway(t, stream => {
      const headers = { ':status': status, 'tiana-error-code': code };
      if (hint !== undefined) headers['tiana-retry-after-ms'] = hint;
      stream.respond(headers, { sendDate: false });
      stream.end(`remote diagnostic ${TOKEN}`);
    });
    const client = new Client(g.options);
    t.after(() => client.close());
    await assert.rejects(client.connect('echo-stream'), error => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.status, status);
      assert.equal(error.retryable, retryable);
      assert.equal(error.committed, false);
      assert.equal(error.gatewayCode, code === TOKEN ? undefined : code);
      assert.ok(!inspect(error).includes(TOKEN));
      assert.ok(!JSON.stringify(error).includes(TOKEN));
      return true;
    });
    assert.equal(g.observations.length, 1);
  }
});

test('closed success envelope rejects missing, duplicate, unexpected and mismatched headers', { timeout: 5000 }, async t => {
  for (const extra of [
    { 'tiana-tunnel-version': '2' }, { 'tiana-request-id': 'req-different' },
    { 'tiana-auth-mode': 'UNKNOWN' }, { 'x-extra': TOKEN },
    { 'tiana-auth-mode': ['TOKEN_REQUIRED', 'DISABLED'] },
    { 'tiana-auth-mode': undefined },
  ]) {
    const g = await gateway(t, (stream, headers) => success(stream, headers, extra));
    const client = new Client(g.options);
    t.after(() => client.close());
    await assert.rejects(client.connect('echo-stream'), error => {
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.equal(error.committed, true);
      assert.equal(error.outcomeUnknown, true);
      assert.ok(!inspect(error).includes(TOKEN));
      return true;
    });
  }
});

test('cancellation before dialing, awaiting response, and after commit releases resources', { timeout: 5000 }, async t => {
  let signalReceived;
  const received = new Promise(resolve => { signalReceived = resolve; });
  const g = await gateway(t, () => signalReceived());
  const client = new Client(g.options);
  t.after(() => client.close());
  await assert.rejects(client.connect('echo-stream', { signal: AbortSignal.abort(TOKEN) }), { code: 'ABORT_ERR', committed: false });
  assert.equal(g.observations.length, 0);
  const abort = new AbortController();
  const pending = client.connect('echo-stream', { signal: abort.signal });
  await received;
  const closed = new Promise(resolve => g.observations[0].stream.once('close', resolve));
  abort.abort(TOKEN);
  await assert.rejects(pending, { code: 'ABORT_ERR', committed: false });
  await closed;

  const echo = await gateway(t, (stream, headers) => success(stream, headers));
  const connected = new Client(echo.options);
  t.after(() => connected.close());
  const activeAbort = new AbortController();
  const tunnel = await connected.connect('echo-stream', { signal: activeAbort.signal });
  const errorEvent = once(tunnel, 'error');
  activeAbort.abort(TOKEN);
  const [error] = await errorEvent;
  assert.equal(error.name, 'AbortError');
  assert.equal(error.committed, true);
  assert.ok(!inspect(error).includes(TOKEN));
  assert.equal(tunnel.destroyed, true);
});

test('connect and response timeouts terminate owned sockets', { timeout: 5000 }, async t => {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.resume();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const c = new Client({ endpoint: ENDPOINT, gateway: { host: '127.0.0.1', port: server.address().port }, connectTimeoutMs: 150 });
  t.after(() => c.close());
  await assert.rejects(c.connect('echo-stream'), { code: 'TIMEOUT', phase: 'tls', committed: false });
  const g = await gateway(t, () => {});
  const client = new Client({ ...g.options, responseTimeoutMs: 150 });
  t.after(() => client.close());
  await assert.rejects(client.connect('echo-stream'), { code: 'TIMEOUT', phase: 'response', committed: false });
});

test('RST after an application write has unknown outcome and is never replayed', { timeout: 5000 }, async t => {
  let writes = 0;
  const g = await gateway(t, (stream, headers) => {
    success(stream, headers);
    stream.once('data', () => { writes++; stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); });
  });
  const client = new Client(g.options);
  t.after(() => client.close());
  const tunnel = await client.connect('echo-stream');
  const errorEvent = once(tunnel, 'error');
  tunnel.write('one-operation');
  const [error] = await errorEvent;
  assert.equal(error.code, 'HTTP2_ERROR');
  assert.equal(error.outcomeUnknown, true);
  assert.equal(writes, 1);
  assert.equal(g.observations.length, 1);
});

test('Client.close cancels owned tunnels and pending requests and is idempotent', { timeout: 5000 }, async t => {
  const g = await gateway(t, (stream, headers) => success(stream, headers));
  const client = new Client(g.options);
  const first = await client.connect('echo-stream');
  const second = await client.connect('echo-stream');
  const errors = Promise.all([once(first, 'error'), once(second, 'error')]);
  client.close();
  client.close();
  for (const [error] of await errors) assert.equal(error.code, 'CLIENT_CLOSED');
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, true);
  await assert.rejects(client.connect('echo-stream'), { code: 'CLIENT_CLOSED' });
  let received;
  const request = new Promise(resolve => { received = resolve; });
  const waiting = await gateway(t, () => received());
  const pendingClient = new Client(waiting.options);
  const pending = pendingClient.connect('echo-stream');
  await request;
  pendingClient.close();
  await assert.rejects(pending, { code: 'CLIENT_CLOSED', committed: false });
});

test('cancelling a flow-controlled write completes its callback and preserves another tunnel', { timeout: 5000 }, async t => {
  let count = 0;
  const g = await gateway(t, (stream, headers) => {
    success(stream, headers);
    if (++count === 2) {
      stream.on('data', chunk => stream.write(chunk));
      stream.on('end', () => stream.end());
    }
  });
  const client = new Client(g.options);
  t.after(() => client.close());
  const abort = new AbortController();
  const blocked = await client.connect('echo-stream', { signal: abort.signal });
  const other = await client.connect('echo-stream');
  const errorEvent = once(blocked, 'error');
  const writeDone = new Promise(resolve => blocked.write(Buffer.alloc(2 * 1024 * 1024), resolve));
  await delay(30);
  abort.abort();
  const [error] = await errorEvent;
  assert.equal(error.code, 'ABORT_ERR');
  assert.ok(await writeDone, 'blocked write callback must receive an error');
  other.end('still-open');
  assert.equal((await collect(other)).toString(), 'still-open');
});

test('TCP refusal and pre-200 RST/GOAWAY fail once', { timeout: 5000 }, async t => {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const unavailable = new Client({ endpoint: ENDPOINT, gateway: { host: '127.0.0.1', port } });
  t.after(() => unavailable.close());
  await assert.rejects(unavailable.connect('echo-stream'), { code: 'TCP_ERROR', committed: false });
  for (const handle of [
    stream => stream.close(http2.constants.NGHTTP2_REFUSED_STREAM),
    stream => stream.session.goaway(http2.constants.NGHTTP2_INTERNAL_ERROR),
  ]) {
    const g = await gateway(t, handle);
    const client = new Client(g.options);
    t.after(() => client.close());
    await assert.rejects(client.connect('echo-stream'), { code: 'HTTP2_ERROR', committed: false });
    assert.equal(g.observations.length, 1);
  }
});

test('explicit destroy closes tunnel and secrets stay out of public object diagnostics', { timeout: 5000 }, async t => {
  const g = await gateway(t, (stream, headers) => success(stream, headers));
  const client = new Client(g.options);
  t.after(() => client.close());
  const tunnel = await client.connect('echo-stream');
  for (const value of [client, tunnel]) {
    assert.ok(!inspect(value, { showHidden: true, depth: 10 }).includes(TOKEN));
    assert.ok(!JSON.stringify(value).includes(TOKEN));
  }
  const closed = new Promise(resolve => g.observations[0].stream.once('close', resolve));
  tunnel.destroy();
  await closed;
  assert.equal(tunnel.destroyed, true);
});

test('TLS trust, hostname, TLS version, and ALPN failures send no CONNECT', { timeout: 8000 }, async t => {
  for (const [tlsOptions, ca] of [
    [{}, fixture('unrelated-cert')],
    [{ cert: fixture('wrong-cert'), key: fixture('wrong-key') }, fixture('wrong-cert')],
    [{ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }, fixture('endpoint-cert')],
  ]) {
    const g = await gateway(t, (stream, headers) => success(stream, headers), tlsOptions);
    const client = new Client({ ...g.options, ca });
    t.after(() => client.close());
    await assert.rejects(client.connect('echo-stream'), { code: 'TLS_ERROR', committed: false });
    assert.equal(g.observations.length, 0);
  }
  const server = tls.createServer({ cert: fixture('endpoint-cert'), key: fixture('endpoint-key'), ALPNProtocols: ['http/1.1'] }, socket => socket.end());
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new Client({ endpoint: ENDPOINT, ca: fixture('endpoint-cert'), gateway: { host: '127.0.0.1', port: server.address().port } });
  t.after(() => client.close());
  await assert.rejects(client.connect('echo-stream'), { code: 'TLS_ERROR' });
});


test('opaque credentials are forwarded unchanged and remain sensitive', { timeout: 5000 }, async t => {
  for (const token of [`tia_1${'A'.repeat(43)}`, 'session.other-format_+/==', 'x'.repeat(4096)]) {
    const g = await gateway(t, (stream, headers) => {
      success(stream, headers);
      stream.on('data', () => {});
      stream.on('end', () => stream.end('ok'));
    });
    const client = new Client({ ...g.options, token });
    t.after(() => client.close());
    const tunnel = await client.connect('echo-stream');
    const output = collect(tunnel);
    tunnel.end();
    assert.equal((await output).toString(), 'ok');
    const headers = g.observations[0].headers;
    assert.equal(headers['proxy-authorization'], `Bearer ${token}`);
    assert.ok(headers[http2.sensitiveHeaders].includes('proxy-authorization'));
  }
});

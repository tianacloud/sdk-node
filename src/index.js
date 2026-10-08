import http2 from 'node:http2';
import tls from 'node:tls';
import { randomBytes, X509Certificate } from 'node:crypto';
import { Duplex } from 'node:stream';
import { inspect } from 'node:util';
import {
  ConnectError, GatewayError, invalid, parseEndpoint, validateToken,
  validateProtocol, validateSuccess, gatewayError,
} from './protocol.js';

export { ConnectError, GatewayError };

function timeoutValue(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > 2_147_483_647) {
    throw invalid('Timeout must be a positive integer in milliseconds');
  }
  return result;
}

function abortError(phase, committed) {
  return new ConnectError('ABORT_ERR', 'CONNECT operation cancelled', phase, committed);
}

/** Owns configuration and all tunnels opened from this client. */
export class Client {
  #options;
  #active = new Set();
  #closed = false;

  constructor(options) {
    if (!options || typeof options !== 'object') throw invalid('Client options are required');
    const endpoint = parseEndpoint(options.endpoint);
    validateToken(options.token);
    const gateway = options.gateway ?? { host: endpoint, port: 443 };
    if (typeof gateway.host !== 'string' || !gateway.host || /[\s/@?#]/.test(gateway.host)
        || !Number.isInteger(gateway.port) || gateway.port < 1 || gateway.port > 65535) {
      throw invalid('Gateway must contain a host and a valid port');
    }
    let ca;
    if (options.ca !== undefined) {
      const roots = Array.isArray(options.ca) ? options.ca : [options.ca];
      if (!roots.length) throw invalid('At least one trust root is required');
      try {
        ca = roots.map(root => {
          if (typeof root !== 'string' && !Buffer.isBuffer(root)) throw new Error();
          new X509Certificate(root);
          return Buffer.from(root);
        });
      } catch { throw invalid('Invalid TLS trust root'); }
    }
    this.#options = {
      endpoint, token: options.token, gateway: { ...gateway }, ca,
      connectTimeoutMs: timeoutValue(options.connectTimeoutMs, 10_000),
      responseTimeoutMs: timeoutValue(options.responseTimeoutMs, 60_000),
    };
  }

  get endpoint() { return this.#options.endpoint; }
  get closed() { return this.#closed; }

  [inspect.custom]() { return `Client { endpoint: '${this.endpoint}', closed: ${this.closed} }`; }

  async connect(protocol, { signal } = {}) {
    validateProtocol(protocol);
    if (this.#closed) throw new ConnectError('CLIENT_CLOSED', 'Client is closed');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalid('Invalid AbortSignal');
    if (signal?.aborted) throw abortError('configuration', false);
    const options = this.#options;
    const requestId = `req-${randomBytes(18).toString('base64url')}`;
    return new Promise((resolve, reject) => {
      let socket, session, stream, tunnel, timer;
      let phase = 'tcp';
      let committed = false;
      let settled = false;
      let released = false;

      const release = (graceful = false) => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#active.delete(cancel);
        if (graceful && session) {
          // Let queued DATA and END_STREAM reach the peer before closing TLS.
          session.close();
          session.once('close', () => socket?.destroy());
        } else {
          if (stream && !stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL);
          session?.destroy();
          socket?.destroy();
        }
      };
      const fail = error => {
        if (released) return;
        if (tunnel) {
          tunnel.destroy(error);
        } else {
          release();
          if (!settled) { settled = true; reject(error); }
        }
      };
      const transportError = () => fail(new ConnectError(
        phase === 'tcp' ? 'TCP_ERROR' : phase === 'tls' ? 'TLS_ERROR' : 'HTTP2_ERROR',
        committed ? 'Tunnel transport failed; outcome unknown' : 'Gateway connection failed',
        phase, committed,
      ));
      const onAbort = () => fail(abortError(phase, committed));
      const cancel = () => fail(new ConnectError('CLIENT_CLOSED', 'Client is closed', phase, committed));
      const deadline = ms => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(new ConnectError('TIMEOUT', 'CONNECT timed out', phase, committed)), ms);
      };
      this.#active.add(cancel);
      signal?.addEventListener('abort', onAbort, { once: true });
      deadline(options.connectTimeoutMs);
      try {
        socket = tls.connect({
          host: options.gateway.host, port: options.gateway.port,
          servername: options.endpoint, ca: options.ca,
          minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ALPNProtocols: ['h2'],
          rejectUnauthorized: true, checkServerIdentity: tls.checkServerIdentity,
        });
        socket.once('connect', () => { phase = 'tls'; });
        socket.on('error', transportError);
        socket.once('close', () => { if (!released && (!stream || !stream.closed)) transportError(); });
        socket.once('secureConnect', () => {
          if (released) return;
          if (!socket.authorized || socket.alpnProtocol !== 'h2' || socket.getProtocol() !== 'TLSv1.3') {
            fail(new ConnectError('TLS_ERROR', 'TLS 1.3 with ALPN h2 is required', 'tls'));
            return;
          }
          phase = 'http2';
          try {
            session = http2.connect(`https://${options.endpoint}`, {
              createConnection: () => socket,
              maxDeflateDynamicTableSize: 0,
              settings: { headerTableSize: 0, maxHeaderListSize: 16 * 1024, enablePush: false },
            });
            session.on('error', transportError);
            session.on('goaway', (code, lastStreamId) => {
              if (code !== 0 || !stream?.id || stream.id > lastStreamId) transportError();
            });
            session.once('close', () => { if (!released && (!stream || !stream.closed)) transportError(); });
            session.once('connect', () => {
              if (released) return;
              const headers = {
                ':method': 'CONNECT', ':authority': `${options.endpoint}:443`,
                'tiana-tunnel-version': '1', 'tiana-database-protocol': protocol,
                'tiana-request-id': requestId,
                [http2.sensitiveHeaders]: ['proxy-authorization'],
              };
              if (options.token !== undefined) headers['proxy-authorization'] = `Bearer ${options.token}`;
              try {
                stream = session.request(headers, { endStream: false });
                // Keep credential-bearing Node objects private for the whole lifetime.
                stream.on('error', transportError);
                stream.on('aborted', transportError);
                stream.once('close', () => { if (!tunnel && !released) transportError(); });
                phase = 'response';
                deadline(options.responseTimeoutMs);
                stream.once('response', (response, flags, rawHeaders) => {
                  if (released) return;
                  if (response[':status'] !== 200) { fail(gatewayError(response)); return; }
                  committed = true;
                  let authMode;
                  try { authMode = validateSuccess(response, rawHeaders, requestId); }
                  catch (error) { fail(error); return; }
                  clearTimeout(timer);
                  phase = 'tunnel';
                  tunnel = new Tunnel(stream, release, { endpoint: options.endpoint, protocol, requestId, authMode });
                  settled = true;
                  resolve(tunnel);
                });
              } catch { transportError(); }
            });
          } catch { transportError(); }
        });
      } catch { transportError(); }
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const cancel of this.#active) cancel();
    this.#options.token = undefined;
  }
}

/** A byte Duplex; end() sends END_STREAM and destroy() closes the whole tunnel. */
export class Tunnel extends Duplex {
  #stream;
  #release;

  constructor(stream, release, metadata) {
    // A readable async iterator must not destroy the still-writable half at EOF.
    super({ allowHalfOpen: true, autoDestroy: false, highWaterMark: 64 * 1024 });
    this.#stream = stream;
    this.#release = release;
    Object.assign(this, metadata);
    stream.pause();
    stream.on('data', chunk => { if (!this.push(chunk)) stream.pause(); });
    stream.once('end', () => this.push(null));
    stream.once('close', () => {
      if (stream.rstCode !== 0) this.destroy(new ConnectError('HTTP2_ERROR', 'Tunnel reset; outcome unknown', 'tunnel', true));
    });
    const closeIfFinished = () => {
      if (this.readableEnded && this.writableFinished) this.destroy();
    };
    this.once('end', closeIfFinished);
    this.once('finish', closeIfFinished);
  }

  [inspect.custom]() { return `Tunnel { endpoint: '${this.endpoint}', protocol: '${this.protocol}', destroyed: ${this.destroyed} }`; }

  _read() { this.#stream.resume(); }
  _write(chunk, encoding, callback) {
    this.#stream.write(chunk, encoding, error => callback(error
      ? new ConnectError('HTTP2_ERROR', 'Tunnel write failed; outcome unknown', 'tunnel', true) : null));
  }
  _final(callback) {
    this.#stream.end(() => callback());
  }
  _destroy(error, callback) {
    this.#release(!error && this.readableEnded && this.writableFinished);
    callback(error);
  }
}

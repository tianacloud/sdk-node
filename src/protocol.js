const ENDPOINT = /^ep-[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const RETRY_PAIRS = new Set([
  '429/CONNECTION_LIMIT', '503/POLICY_UNAVAILABLE',
  '503/INSTANCE_UNAVAILABLE', '504/ACTIVATION_TIMEOUT',
]);
const ERROR_CODES = new Set([
  'MALFORMED_CONNECT', 'EARLY_TUNNEL_DATA', 'AUTH_REQUIRED', 'ACCESS_DENIED',
  'AUTHORIZATION_EXPIRED', 'CALLER_DEADLINE', 'ENDPOINT_MISMATCH',
  'CONNECTION_LIMIT', 'POLICY_UNAVAILABLE', 'INSTANCE_UNAVAILABLE', 'ACTIVATION_TIMEOUT',
]);

/** A bounded error that contains no remote diagnostics or credentials. */
export class ConnectError extends Error {
  constructor(code, message, phase = 'configuration', committed = false) {
    super(message);
    this.name = code === 'ABORT_ERR' ? 'AbortError' : 'ConnectError';
    this.code = code;
    this.phase = phase;
    this.committed = committed;
    this.outcomeUnknown = committed;
  }
}

export class GatewayError extends ConnectError {
  constructor(status, gatewayCode, retryAfterMs) {
    super('GATEWAY_REJECTED', 'Gateway rejected CONNECT', 'response');
    this.name = 'GatewayError';
    this.status = status;
    this.gatewayCode = gatewayCode;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryAfterMs !== undefined && RETRY_PAIRS.has(`${status}/${gatewayCode}`);
  }
}

export function invalid(message) {
  return new ConnectError('INVALID_CONFIGURATION', message);
}

export function parseEndpoint(value) {
  if (typeof value !== 'string') throw invalid('Invalid Tiana endpoint');
  const lower = value.toLowerCase();
  const host = lower.endsWith(':443') ? lower.slice(0, -4) : lower;
  const labels = host.split('.');
  if (labels.length < 2 || !ENDPOINT.test(labels[0]) || labels.some(label =>
      label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw invalid('Invalid Tiana endpoint');
  }
  return host;
}

export function validateToken(token) {
  if (token === undefined) return;
  // Opaque credential: validate only transport safety and a bounded byte length.
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096
      || /[^\x21-\x7e]/.test(token)) {
    throw invalid('Invalid token');
  }
}

export function validateProtocol(protocol) {
  if (typeof protocol !== 'string' || protocol.length < 1 || protocol.length > 64
      || /[^A-Za-z0-9_.-]/.test(protocol)) {
    throw invalid('Invalid CONNECT protocol identifier');
  }
}

export function validateSuccess(headers, rawHeaders, requestId) {
  const expected = [':status', 'tiana-tunnel-version', 'tiana-auth-mode', 'tiana-request-id'];
  if (rawHeaders.length !== 8 || expected.some(name => rawHeaders.filter((value, i) => i % 2 === 0 && value === name).length !== 1)
      || headers['tiana-tunnel-version'] !== '1'
      || headers['tiana-request-id'] !== requestId
      || !['TOKEN_REQUIRED', 'DISABLED'].includes(headers['tiana-auth-mode'])) {
    throw new ConnectError('INVALID_RESPONSE', 'Invalid CONNECT success headers', 'response', true);
  }
  return headers['tiana-auth-mode'];
}

export function gatewayError(headers) {
  const value = headers['tiana-error-code'];
  const code = typeof value === 'string' && ERROR_CODES.has(value) ? value : undefined;
  const hint = headers['tiana-retry-after-ms'];
  const retryAfterMs = typeof hint === 'string' && /^[0-9]{1,5}$/.test(hint)
    && Number(hint) >= 1 && Number(hint) <= 60_000 ? Number(hint) : undefined;
  return new GatewayError(headers[':status'], code, retryAfterMs);
}

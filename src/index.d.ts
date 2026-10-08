import { Duplex } from 'node:stream';

export type AuthMode = 'TOKEN_REQUIRED' | 'DISABLED';
export type ConnectPhase = 'configuration' | 'tcp' | 'tls' | 'http2' | 'response' | 'tunnel';

export interface ClientOptions {
  /** Complete Endpoint hostname returned by MGR, optionally with :443. */
  endpoint: string;
  /** Opaque endpoint credential from MGR; omit for DISABLED endpoints. */
  token?: string;
  /** PEM trust roots. When provided, replaces Node's default trust roots. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** TCP destination only; SNI and CONNECT authority remain the endpoint. */
  gateway?: { host: string; port: number };
  /** TCP + TLS + HTTP/2 setup deadline, defaults to 10000 ms. */
  connectTimeoutMs?: number;
  /** CONNECT response deadline, defaults to 60000 ms. */
  responseTimeoutMs?: number;
}

export class ConnectError extends Error {
  readonly code: string;
  readonly phase: ConnectPhase;
  /** True once HTTP 200 has been received, including an invalid success envelope. */
  readonly committed: boolean;
  readonly outcomeUnknown: boolean;
  constructor(code: string, message: string, phase?: ConnectPhase, committed?: boolean);
}

export class GatewayError extends ConnectError {
  readonly status: number;
  readonly gatewayCode: string | undefined;
  readonly retryAfterMs: number | undefined;
  /** Advisory only. The SDK never retries. */
  readonly retryable: boolean;
  constructor(status: number, gatewayCode?: string, retryAfterMs?: number);
}

export class Client {
  constructor(options: ClientOptions);
  readonly endpoint: string;
  readonly closed: boolean;
  connect(protocol: string, options?: { signal?: AbortSignal }): Promise<Tunnel>;
  /** Cancels pending connects and active tunnels; future connects fail. */
  close(): void;
}

export class Tunnel extends Duplex {
  private constructor();
  readonly endpoint: string;
  readonly protocol: string;
  readonly requestId: string;
  readonly authMode: AuthMode;
}

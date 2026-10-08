import { Client, GatewayError, ConnectError, type Tunnel } from '@tiana/node';
import { Duplex } from 'node:stream';

async function consume() {
  const client = new Client({
    endpoint: 'ep-01j5c9m7q2v8x4k6n3r0t1w2yz.tianacloud.com',
    ca: [Buffer.from('pem')],
    gateway: { host: '127.0.0.1', port: 443 },
  });
  try {
    const tunnel: Tunnel = await client.connect('echo-stream', { signal: AbortSignal.timeout(1000) });
    const stream: Duplex = tunnel;
    const canWrite: boolean = stream.write(Buffer.from('bytes'));
    stream.end();
    for await (const data of stream) Buffer.from(data);
    const mode: 'TOKEN_REQUIRED' | 'DISABLED' = tunnel.authMode;
    void [canWrite, mode];
  } catch (error) {
    if (error instanceof GatewayError) {
      const metadata: [number, string | undefined, number | undefined, boolean] = [
        error.status, error.gatewayCode, error.retryAfterMs, error.retryable,
      ];
      void metadata;
    } else if (error instanceof ConnectError) {
      const committed: boolean = error.outcomeUnknown;
      void committed;
    }
  } finally { client.close(); }
  client.connect('custom-stream-v2');
  // @ts-expect-error Protocol must be a string.
  client.connect(42);
  // @ts-expect-error Gateway ports are numeric.
  new Client({ endpoint: 'ep-example', gateway: { host: 'localhost', port: '443' } });
}
void consume;

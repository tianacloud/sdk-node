import { gatewayAddress } from './gateway-address.mjs';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Client, ConnectError } from '@tiana/node';

async function main() {
  const endpoint = process.env.TIANA_ENDPOINT;
  if (!endpoint) throw new Error('Set TIANA_ENDPOINT');
  const ca = process.env.TIANA_CA_FILE ? await readFile(process.env.TIANA_CA_FILE) : undefined;
  const token = process.env.TIANA_TOKEN;
  const gateway = gatewayAddress(process.env.TIANA_GATEWAY_ADDRESS);
  const client = new Client({ endpoint, token, ca, gateway });
  const abort = new AbortController();
  const onInterrupt = () => abort.abort();
  process.once('SIGINT', onInterrupt);
  try {
    const tunnel = await client.connect(process.env.TIANA_PROTOCOL, { signal: abort.signal });
    await Promise.all([
      (async () => {
        for await (const chunk of process.stdin) {
          if (!tunnel.write(chunk)) await once(tunnel, 'drain');
        }
        tunnel.end();
      })(),
      (async () => {
        for await (const chunk of tunnel) {
          if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
        }
      })(),
    ]);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    client.close();
    process.stdin.destroy();
  }
}

main().catch(error => {
  process.stderr.write(error instanceof ConnectError
    ? `${error.code} (${error.phase})${error.outcomeUnknown ? ': outcome unknown' : ''}\n`
    : 'Tunnel example failed; check configuration and input\n');
  process.exitCode = 1;
});

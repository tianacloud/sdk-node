# Tiana Node.js SDK

`@tiana/node` opens native Tiana v1 CONNECT tunnels and returns a Node.js
`Duplex` byte stream. It uses Node's TLS and HTTP/2 libraries, has no runtime
dependencies, and runs without a Rust helper. Development version:
`0.1.0-dev.0`. Node.js 22 or later, JavaScript ES modules and TypeScript.

## Install

Build a local installable package from this repository:

```sh
npm pack
npm install /path/to/tiana-node-0.1.0-dev.0.tgz
```

The package includes JavaScript, TypeScript declarations and the runnable
example. No compilation is needed to consume it. It is a private development
package; this version is distributed as a local tarball.

## Open a tunnel

```js
import { readFile } from 'node:fs/promises';
import { Client } from '@tiana/node';

const client = new Client({
  endpoint: 'ep-01j5c9m7q2v8x4k6n3r0t1w2yz.tianacloud.com',
  token: process.env.TIANA_TOKEN,
  ca: await readFile('/run/secrets/tiana-ca.pem'),
});

try {
  const tunnel = await client.connect(process.env.TIANA_PROTOCOL, {
    signal: AbortSignal.timeout(30_000),
  });
  // Read concurrently with writes so each direction can make progress.
  const response = (async () => {
    const chunks = [];
    for await (const chunk of tunnel) chunks.push(chunk);
    return Buffer.concat(chunks);
  })();
  tunnel.end('opaque application bytes');
  process.stdout.write(await response);
} finally {
  client.close();
}
```

Omit `token` for an Endpoint configured as `DISABLED`. A supplied token is opaque: 1–4096 visible ASCII bytes without whitespace or
control characters. Prefix, version, exact length and Base64 encoding are not
interpreted; the value is forwarded unchanged. Gateway decides validity and scope.
Supply the complete Endpoint hostname returned by MGR, rather than a bare ID.
Hostnames normalize DNS case and may include `:443`.
For staging, pass `<endpoint_id>.tianacloud-staging.net` through the same options
or `TIANA_ENDPOINT` in the example. The same package supports both environments;
DNS, the Gateway TCP destination and CA trust are deployment inputs.

`ca` accepts PEM text, a PEM Buffer, or an array of either. It replaces Node's
default trust roots when supplied; omit it to use the default roots. TLS
always verifies the Endpoint name and requires TLS 1.3 with ALPN `h2`.

For a local Gateway or alternate listener port, set
`gateway: { host: '127.0.0.1', port: 8443 }`. This changes TCP dialing only.
SNI remains the Endpoint hostname and CONNECT authority remains that
hostname with logical port 443. Setup has a `connectTimeoutMs` deadline
(default 10000); CONNECT response has `responseTimeoutMs` (default 60000).
The optional AbortSignal remains active for the returned tunnel's lifetime.

## Streams and lifecycle

`connect(protocol)` requires an explicit routing identifier and resolves only after
the complete v1 success envelope. The SDK sends no application DATA before
HTTP 200 and preserves server-first bytes. Each call owns one TLS/H2
connection. `Tunnel` provides `endpoint`, `protocol`, `requestId` and
`authMode` metadata.

- `write()` returns `false` when backpressure requires waiting for `drain`.
  Read and write concurrently for transfers larger than the HTTP/2 windows.
- `end()` finishes the write direction with END_STREAM. Continue reading
  until EOF to receive any final response.
- Remote END_STREAM finishes the read direction. The write direction
  remains usable, including after a complete `for await` read loop.
- Both directions finishing releases the connection. `destroy()` closes
  immediately; an AbortSignal cancels the operation with an `AbortError`.
- `client.close()` is idempotent, cancels pending calls and active streams,
  and prevents further connects. Handle active stream `error` events or
  consume the stream through an API that handles errors.

An early `break` from the default async iterator destroys the stream, as
with other Node streams. Use `tunnel.iterator({ destroyOnReturn: false })`
when reading only a prefix and retaining the tunnel. The underlying
credential-bearing HTTP/2 objects are private.

## Errors

`ConnectError` has `code`, `phase`, `committed` and `outcomeUnknown`.
Phases identify configuration, TCP, TLS, HTTP/2, CONNECT response and the
established tunnel. Error codes include `INVALID_CONFIGURATION`,
`TCP_ERROR`, `TLS_ERROR`, `HTTP2_ERROR`, `TIMEOUT`, `INVALID_RESPONSE`,
`ABORT_ERR` and `CLIENT_CLOSED`. Receiving HTTP 200 marks the operation
committed, even when its headers are invalid. A failure after that boundary
has `outcomeUnknown: true`.

`GatewayError` adds `status`, `gatewayCode`, `retryAfterMs` and `retryable`.
The fixed Gateway codes are retained; unknown codes are omitted. Remote
bodies, arbitrary headers, native diagnostic causes and AbortSignal reasons
are excluded from SDK diagnostics. The fixed refusal codes are:

| HTTP | Gateway codes |
| --- | --- |
| 400 | MALFORMED_CONNECT, EARLY_TUNNEL_DATA |
| 407 | AUTH_REQUIRED, ACCESS_DENIED, AUTHORIZATION_EXPIRED |
| 421 | ENDPOINT_MISMATCH |
| 429 | CONNECTION_LIMIT |
| 503 | POLICY_UNAVAILABLE, INSTANCE_UNAVAILABLE |
| 504 | ACTIVATION_TIMEOUT, CALLER_DEADLINE |

Only 429/CONNECTION_LIMIT, 503/POLICY_UNAVAILABLE,
503/INSTANCE_UNAVAILABLE and 504/ACTIVATION_TIMEOUT with a retry hint of
1–60000 ms are `retryable`. This is advisory. The SDK makes one attempt and
never reconnects, retries or replays a session automatically.

## Runnable example

The example copies stdin into a tunnel and copies its output to stdout:

```sh
export TIANA_PROTOCOL=your-registered-profile
export TIANA_ENDPOINT=ep-01j5c9m7q2v8x4k6n3r0t1w2yz.tianacloud.com
export TIANA_CA_FILE=/run/secrets/tiana-ca.pem
# Optional: supply TIANA_TOKEN in the process environment for authenticated access.
printf 'opaque application bytes' |
  node node_modules/@tiana/node/examples/tunnel.mjs
```

Set `TIANA_GATEWAY_ADDRESS=127.0.0.1:8443` for an alternate physical
listener. Supply an explicit port (1–65535); IPv6 uses `[::1]:8443`.
This changes only TCP dialing; Endpoint TLS identity and CONNECT authority stay
unchanged. The old separate host/port and dial-address variables are ignored. In the source repository use `node examples/tunnel.mjs`. Ctrl-C
cancels the tunnel. The selected Endpoint must support the caller-selected profile and understand
the input bytes. External Gateway smoke scripts also require TIANA_PROTOCOL.

## Validation

```sh
npm ci --ignore-scripts
npm test
npm run test:types
npm run test:package
npm run test:gateway -- /path/to/qa-gateway-fixture
```

The direct tests use synthetic TLS/H2 servers and the pinned Rust test
certificates. They cover authority, TLS trust/name/version/ALPN, Token
sensitivity, the pre-200 barrier, both half-close orders, multi-window
backpressure, cancellations, errors, diagnostics and resource cleanup.
`test:package` installs the tarball into a fresh consumer and checks a
JavaScript tunnel, strict TypeScript and the packaged example.

The Gateway smoke uses frozen Gateway
`4e026bcd34864e9c6aca4932ccad5e8c17f0496f` with synthetic
Control/Runtime/Agent services. It verifies anonymous and Token-required
tunnels, greeting and tail bytes, 1 MiB transfers, three refusals and
post-commit cancellation. Details are in `evidence/validation.md`.
Fixture provenance is in `test/fixtures/README.md`.

## Limitations

The SDK transports registered profile bytes. Database clients, SQL parsing
and WebSocket framing belong to the caller. This package's runtime target
is Node.js; Bun, Deno and browsers are unverified. JavaScript does not provide
guaranteed erasure of immutable credential strings from memory. The local
Gateway evidence uses a synthetic Agent and establishes no new production
Agent half-close guarantee.

## Generic channel boundary

Protocol identifiers contain 1–64 ASCII letters, digits, dots, underscores or
hyphens. The SDK forwards them in the existing tiana-database-protocol header;
only the Gateway decides supported profiles. There is no built-in application
protocol enum or allowlist. Application adapters are separate dependent packages.
No compatibility alias for the old union type is retained. Historical Gateway
evidence is preserved; it is not a claim that its external fixture was rerun.

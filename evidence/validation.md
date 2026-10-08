# Native Node.js CONNECT validation

Validated source commit: `b49bf6b14e3a570031fc2d9b80059441e6672c60`.
Validated on 2026-09-05 with Node.js 22.23.1, npm 10.9.8 and TypeScript 5.9.3.
Package: `@tiana/node@0.1.0-dev.0`. Runtime dependencies: none.

| Validation | Result |
| --- | --- |
| `npm test` | 15 tests passed; zero failures, cancellations or skips |
| `npm run test:types` | Strict source-package TypeScript consumer passed |
| `npm run test:package` | Fresh local tarball install, JS stream, strict TS consumer, packaged stdin/stdout example and single-SIGINT exit with stdin open passed |
| Frozen Gateway anonymous tunnel | 1 MiB exact echo, greeting, write EOF and EOF tail passed |
| Frozen Gateway Token-required tunnel | 1 MiB exact echo, greeting, write EOF and EOF tail passed |
| Frozen Gateway refusal metadata | 407/AUTH_REQUIRED, 407/ACCESS_DENIED, 503/POLICY_UNAVAILABLE passed |
| Frozen Gateway cancellation | Established tunnel reports ABORT_ERR and outcomeUnknown=true |

The direct TLS/H2 tests cover both half-close orders, server-first bytes,
2 MiB write backpressure, a 3 MiB slow read, canonical authority, zero DATA
before HTTP 200, sensitive Token headers, advertised table size zero,
closed success headers, the 11 fixed Gateway codes, bounded retry hints,
TCP/TLS/ALPN failures, cancellation before and after acceptance, blocked
write cancellation, another tunnel's continued operation, client closure,
and pre/post-200 errors without replay. SDK object and error diagnostics
exclude the synthetic Token.

The tarball contains only `LICENSE`, `README.md`, `package.json`,
`examples/tunnel.mjs`, `src/index.js`, `src/index.d.ts` and `src/protocol.js`.

## Fixed inputs and integration boundary

- Contracts: `59b3b4654511eb01b6d0c350fff8b7e22bbb0268`.
- Rust test/reference assets: `3b8d64fd692e3b2edaebf4233ec25bf15bcc53d6`.
- Gateway: `4e026bcd34864e9c6aca4932ccad5e8c17f0496f`.

Shared QA fixture repository:
`qa-native-connect`.
Shared QA fixture tag: `qa-2026-09-05`.

The integration fixture runs the exact Gateway public TLS/H2 ingress,
CONNECT validation, authorization/commit, Route Handshake v1 client and
relay. Control, Runtime, clock and loopback Agent are synthetic services.
Its Token and CA are synthetic test files. No business database or
production credential is involved. The SDK consumer uses no Rust helper.

Run `node scripts/gateway-smoke.mjs <fixture-directory>` while the fixture
is running. It reads `ready.json`, `fixtures/gateway.pem` and
`fixtures/synthetic-token.txt`, and prints only safe result metadata.

## Limitations

The integration test proves the fixed public Gateway with a synthetic
Agent. It does not establish new production Agent half-close behavior.
This SDK transports profile bytes and does not implement a database or
WebSocket client. Node.js is the supported runtime; Bun/Deno/browser
behavior is unverified. There is one physical connection per tunnel.

# CONNECT test inputs

`public-connect-authority-v1.json` supplies the online and staging hostname
suffixes used by these tests. Endpoint identity grammar and logical port 443
are unchanged; callers pass the complete hostname supplied by MGR.
`public-connect-v1.md` describes the transport rules exercised by this package.

The original PEM certificate and private-key fixtures came from the DER fixtures in
`tests/support/tls_fixtures.rs` in Rust reference commit
`3b8d64fd692e3b2edaebf4233ec25bf15bcc53d6`, wrapped as PEM. They are
synthetic test credentials. The endpoint certificate was reissued with the same
synthetic key for both online and staging Endpoint hostnames. The remaining
wrong-name and unrelated-root certificates
exercise TLS rejection. None of these fixtures ship in the npm package.

The public error-code set and status mapping follow Gateway commit
`4e026bcd34864e9c6aca4932ccad5e8c17f0496f`,
`crates/gateway-public/src/ingress.rs`, `PublicErrorCode`.

Node stream and HTTP/2 interfaces follow the official API documentation:
https://nodejs.org/docs/latest-v22.x/api/stream.html and
https://nodejs.org/docs/latest-v22.x/api/http2.html.

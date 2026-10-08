# Generic Node transport boundary

Decision (2026-09-28): this repository provides TLS 1.3/H2 CONNECT and a generic
Duplex byte stream only. Callers supply a 1–64 character ASCII protocol identifier
(letters, digits, dot, underscore, hyphen). The Gateway owns profile registration;
there is no client-side application protocol enum, default, codec or helper.
The existing `tiana-database-protocol` header is a wire contract and is retained.

Preserve endpoint/SNI validation, credential redaction, sensitive-header handling,
pre-200 DATA barrier, two-way backpressure, half-close and connection ownership.
No application request replay is allowed. Protocol identifiers are validated
before dialing. Each tunnel owns its connection; Client.close cancels all of them.

The user explicitly excludes compatibility and migration. Remove the old closed
protocol type without an alias. Reverting this boundary requires reverting the
paired consumer changes; there is no persisted format change. No database or
filesystem state is introduced. The generic interface does not grant support for
an unregistered server profile. Existing credential/authentication scope remains.

Validate malformed identifiers, forwarding of custom identifiers, TLS/H2 behavior,
flow control, cancellation and cleanup, strict TypeScript, and installed tarballs
on Node 22+. Test fixture disconnect waits must tolerate a reset while awaiting
close. Historical external Gateway evidence is not a claim of a fresh run.


## 2026-09-28: API origin and explicit token environment

Use TIANA_API_ORIGIN as the sole API-origin environment name wherever an
origin is loaded. TIANA_MGR_ORIGIN and TIANA_AUTH_ORIGIN are ignored; do not add
compatibility aliases. Explicit API constructor parameters remain available.
Remove TIANA_TOKEN_FILE and raw token-file credential readers. CLI connections
use explicit TIANA_TOKEN (presence is authoritative: empty/malformed fails),
otherwise the selected saved account access token. SDK examples use TIANA_TOKEN;
library constructors continue to accept explicit token values. Never log tokens.
Account credential persistence and refresh locking are separate from raw token
file input and remain intact. No on-disk schema, network protocol or transaction
semantics change. Old environment names deliberately stop working without a
migration fallback. Rollback requires reverting code/docs together.

TIANA_PENDING_COMMAND_FILE, TIANA_CREDENTIALS_FILE and TIANA_GATEWAY_ADDRESS are
under review only; this change does not remove them or pending-operation state.
Keep bounded token validation, existing credential file protections, and explicit
SDK dial overrides. Verify retired names cannot override current configuration,
empty tokens fail closed, saved accounts still work, and runnable SDK examples
accept TIANA_TOKEN without reading a raw token file. No extra network round trips
or file reads may be introduced by environment resolution.


## 2026-09-28: one Gateway address environment name

User requires TIANA_GATEWAY_ADDRESS for example/launcher TCP overrides.
TIANA_DIAL_ADDRESS, TIANA_GATEWAY_HOST and TIANA_GATEWAY_PORT are removed names,
not fallback aliases. Existing explicit SDK Config.DialAddress / gateway options
retain their API names. No implicit environment reads are added to core SDKs.
Endpoint continues to determine TLS SNI, hostname verification and CONNECT
identity. Override only the physical TCP destination, never certificate checks.

Examples consume host:port, with bracketed IPv6. Node example adapters require a
canonical decimal port 1-65535 and reject URLs, credentials, paths and malformed
addresses without echoing the input. Keep these adapters in packaged examples;
do not introduce a public library API for environment parsing. This changes no
wire or storage format, database semantics, retry policy or connection ownership;
parsing adds only bounded work proportional to address input before dialing.
No migration shim: update launch environments, revert code/docs together if needed.
Verify IPv4/hostname/IPv6 parsing, malformed input rejection, installed examples,
and a real TLS/CONNECT exchange with conflicting removed variables present.


## 2026-09-28: opaque Gateway credentials

A Gateway-accepted 48-character credential was rejected by the former fixed
47-character/base64 InstanceToken parsers. Treat credentials as opaque, as sdk-go
and current Public CONNECT/Token specifications require. Accept 1..4096 visible
ASCII bytes (0x21..0x7e); reject empty, whitespace, control, non-ASCII and oversized
input before I/O/allocation. Do not infer prefix/version/type/scope, decode base64,
trim, normalize or append padding. The maximum is a resource bound with headroom
under the existing 16 KiB header-list budget, not a token-format discriminator.
Gateway remains the authentication authority; no authentication bypass/fallback.

Preserve exact Bearer bytes, never-indexed/sensitive headers, redacted errors,
owned-buffer clearing where supported and existing no-replay/TLS guarantees.
Removing base64 parsing removes temporary decoded secrets; validation is one
bounded linear scan at configuration time, with no payload hot-path work. No
storage, transaction, persisted schema or server wire change. This deliberately
accepts additional opaque representations; rollback reinstates the old client
rejection and must not transform saved credentials. Go's broader HTTP header
value check is the opacity reference, not a claim of identical whitespace policy.

Use only synthetic credentials in committed tests. Cover old/new-length and
non-prefix tokens, exact protected header forwarding, invalid/control/oversize
input, redaction and owned-buffer cleanup. Validate installed built artifacts
and real read-only notes demos without persisting user credentials. Isolated
verification may exercise unpublished changed artifacts; production adapter
manifests remain pinned remote HTTPS and must be refreshed after authorized
publication. No commit/push is authorized by this fix alone.

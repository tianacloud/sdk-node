# Public CONNECT authority v1

Public Client-to-Gateway database sessions use TLS 1.3 with ALPN `h2` and a
regular HTTP/2 CONNECT stream. The complete Endpoint hostname contains:

```text
<endpoint_id>.<deployment_suffix>
endpoint_id = ^ep-[0-7][0-9a-hjkmnp-tv-z]{25}$
```

MGR returns the complete hostname for its configured environment. The SDK
uses that value unchanged apart from DNS case normalization. Test deployments
use `tianacloud.com` and `tianacloud-staging.net`; the logical port is 443.

The TLS SNI and normalized CONNECT `:authority` hostname must be identical and
name one Endpoint. DNS case is normalized to lowercase. An omitted authority
port means 443; the only allowed explicit port is `:443`. A physical connection
is bound to its SNI Endpoint, so a stream for another Endpoint is rejected and
must not reach policy lookup, activation, Runtime, or Agent I/O.

The L4 listener may be reached through a different transport port such as a
Kubernetes NodePort, but that deployment detail does not change the canonical
`:authority` port. The listener terminates TLS itself; an L4 proxy must not
terminate TLS, rewrite SNI or CONNECT headers, or inspect the optional raw
InstanceToken.

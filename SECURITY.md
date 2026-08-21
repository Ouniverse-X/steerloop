# Security policy

## Supported versions

Steerloop is pre-release software. Only the latest commit on `main` receives
security fixes during the private alpha.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Contact the repository
owner privately through GitHub until a dedicated security contact is published.

Include:

- the affected component and commit;
- reproduction steps;
- the expected and observed security boundary;
- potential impact;
- any suggested mitigation.

## Current security posture

The development relay is not production-ready. In particular:

- the initial milestone uses a shared bearer token;
- end-to-end encryption and device-bound approval signatures are not yet
  implemented;
- the PWA is intended for localhost development;
- no component should be exposed publicly without TLS and a strong token.

The reference remote deployment terminates HTTPS/WSS at Caddy, mounts the Relay
token from a secret file, keeps port 8787 private, and uses read-only container
root filesystems. It is suitable for controlled alpha testing, not multi-user
production.

The host agent never accepts arbitrary shell commands from the relay. Remote
commands are validated against a narrow protocol allowlist, and approval
decisions are bound to the digest of a pending request. The browser recomputes
that digest over the security-sensitive fields and disables approval if the
displayed request does not match.

During the alpha, the browser stores its Relay URL and bearer token in local
storage. Do not use a shared or untrusted browser profile, and treat any script
running on the PWA origin as security-sensitive.

The persistent Relay journal contains commands, filesystem paths, session
summaries, and approval metadata. Protect its volume with host access controls
and encrypted backups. The alpha journal is not encrypted by Steerloop itself.

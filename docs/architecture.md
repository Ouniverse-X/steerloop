# Architecture

## Design goals

Steerloop is built around four constraints:

1. Work stays on the host that owns the checkout and credentials.
2. Hosts make outbound connections; users do not expose an agent port.
3. Mobile controls are semantic and allowlisted, not a remote shell.
4. Every approval is bound to one pending request and expires.

## Components

### Protocol

`@steerloop/protocol` defines provider-neutral events and commands. Adapters
translate provider-specific messages into this protocol so the relay and UI do
not depend on Codex internals.

### Host agent

The host agent owns provider processes and the final authorization decision. It
tracks pending approvals locally and rejects stale, duplicated, or mismatched
decisions.

The Codex adapter uses the App Server's local stdio JSONL transport. Direct
App Server WebSocket exposure is intentionally out of scope.

The DeepSeek Harness integration is a Cordis plugin bridge. It connects to Relay
as a host, listens to Harness `session/event` activity, and registers a Harness
`approval/request` answerer that waits for Steerloop device-signed approvals.
The bridge uses the stable public seams available in the Harness developer
preview and avoids replacing Harness UI, storage, or scheduler components.

### Relay

The relay authenticates connections, forwards events to subscribed clients, and
forwards allowlisted commands to the intended host. Validated events are synced
to a bounded JSONL journal before broadcast. Startup replays that journal and
repairs only a crash-truncated final record; other corruption fails closed.

During alpha pairing, an authenticated host registers a short-lived pairing
code. A browser submits that code to Relay over `/pair`; Relay returns a
browser-local client token that is accepted for client WebSocket authentication.
The browser also registers a P-256 public key. Relay stores only a token hash,
that public key, and device metadata in its device registry. Devices can be
listed and revoked over `/devices`. The shared Relay token remains required for
host connections.

### Web console

The PWA reduces events into a local view of hosts, sessions, recent activity,
and pending approvals. It never constructs arbitrary host commands. Before it
enables an approval decision, it independently recomputes the digest from the
displayed security-sensitive fields and compares it with the host-bound digest.
When the browser was paired, approval decisions are signed by that browser's
local device key before being sent to Relay.

## Trust boundaries

```text
┌──────────────── trusted host ────────────────┐
│ Provider process ⇄ adapter ⇄ approval store │
└─────────────────────┬────────────────────────┘
                      │ authenticated channel
              ┌───────▼───────┐
              │     relay     │  untrusted for authorization
              └───────┬───────┘
                      │ authenticated channel
              ┌───────▼───────┐
              │ mobile client │
              └───────────────┘
```

During the current alpha, hosts still authenticate with a shared bearer token,
while browsers can either use that token directly or pair through a short-lived
host code. Paired browser tokens survive Relay restarts and can be revoked.
For paired browsers, Relay requires `approval.resolve` commands to include an
ECDSA P-256 signature over the command ID, host/session IDs, approval ID,
request digest, decision, device ID, and command timestamps. Shared-token
browser clients remain an admin/development path and are not device-signed.
The roadmap adds QR pairing, end-to-end encryption, and stronger rotation
policy. Host-side and browser-side digest checks are present from the beginning,
so a relay cannot substitute or misrepresent a different pending request without
the decision being blocked.

## Remote edge

The supported remote-alpha topology puts Caddy in front of both the static PWA
and Relay. HTTPS and WSS share one origin, and only ports 80 and 443 are public.
Relay port 8787 stays inside the container network. The host Agent initiates its
outbound WSS connection; Codex App Server remains a local stdio child process.

## Event ordering

Each host emits monotonically increasing sequence numbers. The relay preserves
the envelope and keeps a bounded history. Clients treat `(hostId, sequence)` as
the ordering key and ignore duplicates.

## Provider adapter contract

Adapters expose:

- lifecycle start and stop;
- a stream of normalized events;
- `resolveApproval`, `sendPrompt`, and `interrupt` capabilities when supported;
- a capability list so unavailable controls are not shown.

Provider-specific payloads do not cross the adapter boundary unless explicitly
redacted and included as display-only metadata.

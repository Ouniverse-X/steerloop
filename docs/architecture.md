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

### Relay

The relay authenticates connections, forwards events to subscribed clients,
forwards allowlisted commands to the intended host, and keeps a bounded in-memory
event history for reconnects. Persistent encrypted history comes later.

### Web console

The PWA reduces events into a local view of hosts, sessions, recent activity,
and pending approvals. It never constructs arbitrary host commands. Before it
enables an approval decision, it independently recomputes the digest from the
displayed security-sensitive fields and compares it with the host-bound digest.

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

During the initial milestone, the relay and clients share a bearer token. The
roadmap replaces this with device identities, end-to-end encryption, and signed
approval decisions. Host-side and browser-side digest checks are present from
the beginning, so a relay cannot substitute or misrepresent a different pending
request without the decision being blocked.

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

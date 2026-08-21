# ADR 0001: Local-first control plane with normalized events

- Status: Accepted
- Date: 2026-08-21

## Context

Steerloop needs to expose enough agent state for remote supervision without
turning the relay into a remote shell or coupling every client to a provider's
internal protocol.

Codex App Server offers authentication, conversation history, approvals, and
streamed events over a local stdio transport. Its direct WebSocket transport is
currently experimental, so exposing it publicly would make the product depend
on an unstable and overly broad interface.

## Decision

- Run a Steerloop Agent on every controlled host.
- Connect provider processes locally through an adapter.
- Normalize provider messages into the Steerloop protocol.
- Connect the host agent outbound to a relay.
- Allow only protocol-defined commands back to the host.
- Keep the final approval check and provider response on the host.

## Consequences

The relay and mobile client remain provider-neutral, and a future provider can
start with read-only monitoring. The host agent is more complex because it must
translate events and retain pending approval state. That complexity is accepted
because it preserves the security boundary and avoids public App Server access.

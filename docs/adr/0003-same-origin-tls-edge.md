# ADR 0003: Same-origin TLS edge for remote access

- Status: accepted
- Date: 2026-08-21

## Context

Remote phones require HTTPS for installable PWA behavior and secure WebSocket
transport. Directly exposing either Codex App Server or the Steerloop Relay would
widen the attack surface and complicate certificate and browser policy handling.

## Decision

Caddy is the only public service. It terminates TLS, serves the PWA through an
internal static web container, and proxies `/ws` and `/healthz` to the internal
Relay. The browser derives `wss://<page-origin>/ws`; Relay port 8787 stays on the
Compose network. Codex App Server continues to use local stdio only.

The Relay token is mounted as a Docker secret, containers use read-only root
filesystems where practical, and the edge emits restrictive security headers.

## Consequences

- The public firewall needs only ports 80 and 443.
- Certificates are issued and renewed automatically for a valid DNS name.
- Cross-origin Relay configurations are blocked by the production CSP.
- Caddy state and the Relay journal require persistent volumes and backups.
- Shared bearer authentication remains an alpha limitation pending per-device
  identity and signed decisions.

# Roadmap

## Milestone 0 — Repository foundation

- [x] Product proposal and positioning
- [x] Repository conventions and CI
- [ ] Shared protocol and reducer
- [ ] Local demo adapter
- [ ] In-memory relay
- [ ] Mobile-first web console

Exit condition: `npm run dev` demonstrates one full approval round trip and
`npm run check` passes locally and in CI.

## Milestone 1 — Codex local integration

- [ ] Spawn Codex App Server over stdio
- [ ] Initialize and list stored threads
- [ ] Normalize thread and turn lifecycle events
- [ ] Forward command and file-change approval requests
- [ ] Return one-time accept, decline, and cancel decisions
- [ ] Queue or steer text input
- [ ] Interrupt an active turn
- [ ] Compatibility tests against a pinned Codex CLI version

Exit condition: a real Codex session can be monitored and unblocked from the
web console without exposing App Server on the network.

## Milestone 2 — Reliable remote alpha

- [ ] Durable local event journal
- [ ] Relay reconnect and event replay
- [ ] QR pairing and per-device identity
- [ ] Device-bound approval signatures
- [ ] TLS deployment guide
- [ ] PWA install and push notifications
- [ ] Host service installation for Linux and macOS

Exit condition: a phone on a different network can safely control a test host
through a deployed relay, including a 30-minute disconnect.

## Milestone 3 — Review and multi-host workflows

- [ ] Changed-file and diff summaries
- [ ] Test-result normalization
- [ ] Multi-host search and filters
- [ ] Session rename, pin, and archive
- [ ] Self-hosted relay packaging
- [ ] Audit export

## Milestone 4 — Multi-agent control plane

- [ ] Public provider-adapter interface
- [ ] Read-only adapter capability level
- [ ] Interactive adapter capability level
- [ ] Structured approval capability level
- [ ] Team roles, policy templates, and approval delegation

## Explicit non-goals

- arbitrary remote shell access;
- mobile source-code editing;
- replacing provider sandboxes;
- storing developer credentials in the relay;
- silently approving destructive or scope-expanding actions.

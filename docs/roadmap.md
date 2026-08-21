# Roadmap

## Milestone 0 — Repository foundation

- [x] Product proposal and positioning
- [x] Repository conventions and CI
- [x] Shared protocol and reducer
- [x] Local demo adapter
- [x] In-memory relay
- [x] Mobile-first web console

Exit condition: `npm run dev` demonstrates one full approval round trip and
`npm run check` passes locally and in CI.

## Milestone 1 — Codex local integration

- [x] Spawn Codex App Server over stdio
- [x] Initialize and list stored threads
- [x] Normalize thread and turn lifecycle events
- [x] Forward command and file-change approval requests
- [x] Return one-time accept, decline, and cancel decisions
- [x] Queue or steer text input
- [x] Interrupt an active turn
- [x] Compatibility tests against a pinned Codex CLI version

Exit condition: a real Codex session can be monitored and unblocked from the
web console without exposing App Server on the network.

## Milestone 2 — Reliable remote alpha

- [x] Durable local event journal
- [x] Relay reconnect and event replay
- [x] Short-code browser pairing
- [x] Persistent browser device registry
- [x] Device listing and revocation
- [ ] QR pairing
- [x] Device-bound approval signatures
- [x] TLS deployment guide
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

- [x] DeepSeek Harness Cordis plugin bridge MVP
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

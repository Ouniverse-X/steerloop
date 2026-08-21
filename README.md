# Steerloop

> Keep every agent loop within reach.

Steerloop is a local-first control plane for monitoring, steering, and securely
approving long-running AI agent tasks from anywhere.

The agent keeps running on your computer or server. Steerloop gives you a
mobile-friendly view of its progress and a deliberately small set of controls:
review a request, approve it once, decline it, send guidance, or interrupt the
run.

## Project status

Steerloop is in an early private-alpha stage. The first milestone is a local
end-to-end demo with four parts:

- a shared, provider-neutral event protocol;
- a host agent with Codex App Server and demo adapters;
- an outbound-only relay;
- a mobile-first PWA control console.

Do not expose the current development relay to the public internet or use it to
control production systems.

## Architecture

```text
Codex App Server ──stdio── Steerloop Agent
                              │
                              │ authenticated outbound WebSocket
                              ▼
                        Steerloop Relay
                              │
                              ▼
                       Web / PWA Console
```

Codex remains responsible for its sandbox and approval policy. Steerloop adds a
transport and control surface; it does not bypass the host's security boundary.

See [the architecture](docs/architecture.md), [roadmap](docs/roadmap.md), and
[product proposal](docs/product-proposal.md) for details.

## Local development

Requirements:

- Node.js 18.18 or newer
- npm 9 or newer
- Codex CLI for the real Codex adapter (the demo adapter does not require it)

```bash
npm install
npm run dev
```

The development command starts the relay, demo agent, and web console. It uses
the local-only development token `steerloop-local-dev`. Open the URL printed by
Vite and wait for the demo session to request an approval.

For separate processes:

```bash
npm run dev:relay
npm run dev:agent
npm run dev:web
```

Before exposing any component beyond localhost, set a strong
`STEERLOOP_TOKEN`, terminate TLS at a trusted reverse proxy, and review
[SECURITY.md](SECURITY.md).

## Quality gates

```bash
npm run check
```

This runs type checking, tests, and production builds across the workspace.

## Repository layout

```text
apps/
  agent/       Host daemon and provider adapters
  relay/       Authenticated event and command relay
  web/         Mobile-first PWA console
packages/
  protocol/    Shared events, commands, validation, and reducers
docs/          Product, architecture, decisions, and roadmap
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Security issues
should follow the private reporting process in [SECURITY.md](SECURITY.md).

## License

No open-source license has been selected yet. All rights are reserved until a
license is added to this repository.

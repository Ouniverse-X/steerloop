# DeepSeek Harness plugin

`@steerloop/dsh-plugin` lets a DeepSeek Harness runtime appear in Steerloop like
any other long-running agent host. It is a Cordis plugin: add it to a Harness
composition, point it at a Steerloop Relay, and use the existing Steerloop
browser or phone console for observation and approvals.

## Product behavior

The plugin connects to Relay as a Steerloop host agent. It listens to Harness
`session/event` events, maps useful session, turn, assistant, and tool activity
into the Steerloop event protocol, and registers a pairing code for browser or
phone binding.

For approval requests, the plugin registers a Harness `approval/request`
answerer. When Harness asks for a decision, the plugin emits a Steerloop
`approval.requested` event and waits for the remote console to send
`approval.resolve`. The existing Steerloop Relay verifies paired-device
signatures before the command reaches the plugin.

## Local configuration

Start the Steerloop stack:

```bash
npm run dev:relay
npm run dev:web
```

Add the plugin as a Harness patch overlay:

```yaml
- insert:
    - id: steerloop
      name: '@steerloop/dsh-plugin'
      config: {}
```

Open the Steerloop web console, enter the pairing code printed or configured for
the plugin, and bind the browser as a device.

## Remote configuration

For HTTPS/WSS deployment, configure the plugin with the same Relay endpoint and
token used by other Steerloop hosts:

```yaml
- insert:
    - id: steerloop
      name: '@steerloop/dsh-plugin'
      config:
        relayUrl: "wss://steerloop.example/ws"
        token: "replace-with-a-high-entropy-token"
        hostId: "gpu26-dsh"
        hostName: "gpu26 DeepSeek Harness"
        pairingCode: "PAIR-2026"
```

Use a high-entropy token in remote deployments and avoid committing the token or
pairing code into a shared repository.

## Configuration fields

| Field | Default | Purpose |
| --- | --- | --- |
| `relayUrl` | `STEERLOOP_RELAY_URL` or `ws://127.0.0.1:8787/ws` | Relay WebSocket endpoint. |
| `token` | `STEERLOOP_TOKEN` or `steerloop-local-dev` | Shared host token for Relay authentication. |
| `hostId` | `STEERLOOP_HOST_ID` or hostname plus `-dsh` | Stable host identity shown in Steerloop. |
| `hostName` | `STEERLOOP_HOST_NAME` or hostname plus ` DeepSeek Harness` | Display name in the console. |
| `pairingCode` | `STEERLOOP_PAIRING_CODE` or random short code | Browser/mobile pairing code. |
| `pairingTtlMs` | `600000` | Pairing code lifetime. |
| `approvalTimeoutMs` | `300000` | Remote approval wait time. |
| `heartbeatMs` | `15000` | Host heartbeat interval. |
| `approvals` | enabled | Set to `false` to observe only and delegate approval to another answerer. |
| `requireRelayUrl` | disabled | Throw at startup when neither config nor `STEERLOOP_RELAY_URL` supplies a Relay URL. |
| `requireToken` | disabled | Throw at startup when neither config nor `STEERLOOP_TOKEN` supplies a Relay token. |

## Current limits

- The first version uses Harness public seams `session/event` and
  `approval/request`; it intentionally avoids deeper developer-preview internals.
- `session.prompt` and `session.interrupt` are not advertised until a stable
  Harness service seam is selected for them.
- Approval details come from `approval/request` and the recent `tool/call` with
  the same `callId` when available.

## Verified local smoke

The plugin was loaded into the local DeepSeek Harness checkout at
`/home/beihang/projects/Harness/deepseek-harness` with the Harness-provided Node
24 environment. The smoke covered:

- `dsh --profile headless --patch <tmp patch> --dump-config`;
- `dsh --profile headless --patch <tmp patch> "Steerloop smoke: say hello and stop."`;
- temporary Steerloop Relay on port `18887`, where Harness printed the pairing
  code and Relay logged the host pairing offer.

Reusable overlays are available under
[`examples/deepseek-harness`](../examples/deepseek-harness/README.md).
Use `source-checkout.cordis.yml` for this local repository checkout before the
package is installed into a Harness profile.

## Publishing

For package publication readiness and blockers, see [the DSH plugin npm publishing checklist](dsh-plugin-publishing.md).

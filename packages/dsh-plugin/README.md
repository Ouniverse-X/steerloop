# @steerloop/dsh-plugin

`@steerloop/dsh-plugin` connects a DeepSeek Harness runtime to a Steerloop Relay.
It is a thin Cordis plugin for adding Steerloop mobile/browser observation and
remote approval handling to existing `dsh` profiles.

## Status

This package is release-candidate quality for private npm testing. It has been
loaded by a real DeepSeek Harness `headless` profile and verified against a
local Steerloop Relay. The package is marked `UNLICENSED` until the repository
license is selected; do not publish it as an open-source package before that
product decision is made.

## Requirements

- DeepSeek Harness developer preview with Cordis patch overlays.
- Node `^22.19.0 || >=24.0.0`, matching the current Harness engine range.
- A reachable Steerloop Relay.

## What it does

- connects to Steerloop Relay as a host agent;
- emits Harness session, turn, assistant, tool, and approval events as
  Steerloop protocol events;
- registers a short pairing code so a phone/browser can bind as a Steerloop
  device;
- answers Harness `approval/request` prompts from signed Steerloop
  `approval.resolve` commands.

The plugin does not replace Harness UI or storage. It adds a remote control
plane for long-running Harness jobs.

## Install into a Harness profile

After publication:

```bash
dsh plugin --profile headless add @steerloop/dsh-plugin
```

Before publication, install from this checkout:

```bash
dsh plugin --profile headless add "file:/home/beihang/projects/Steerloop/packages/dsh-plugin"
```

For one-off development without modifying the Harness profile, use the
`source-checkout.cordis.yml` overlay in the Steerloop repository examples.

## Cordis configuration

Add the plugin as a Harness patch overlay after the session and approval
plugins:

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
        requireRelayUrl: true
        requireToken: true
```

For local development with the default Steerloop stack:

```yaml
- insert:
    - id: steerloop
      name: '@steerloop/dsh-plugin'
      config: {}
```

By default the plugin uses `ws://127.0.0.1:8787/ws` and
`steerloop-local-dev`. It prints the pairing code after Relay authentication.

## Configuration

| Field | Default | Purpose |
| --- | --- | --- |
| `relayUrl` | `STEERLOOP_RELAY_URL` or `ws://127.0.0.1:8787/ws` | Steerloop Relay WebSocket endpoint. Must use `ws:` or `wss:`. |
| `token` | `STEERLOOP_TOKEN` or `steerloop-local-dev` | Relay shared host token. Use a high-entropy secret remotely. |
| `hostId` | `STEERLOOP_HOST_ID` or OS hostname plus `-dsh` | Stable host identity shown in Steerloop. |
| `hostName` | `STEERLOOP_HOST_NAME` or OS hostname plus ` DeepSeek Harness` | Display name. |
| `pairingCode` | `STEERLOOP_PAIRING_CODE` or random short code | Browser/mobile pairing code, 6-32 chars using `A-Z`, `0-9`, or `-`. |
| `pairingTtlMs` | `600000` | Pairing code lifetime. |
| `approvalTimeoutMs` | `300000` | How long a Harness approval waits for a remote decision. |
| `heartbeatMs` | `15000` | Relay heartbeat interval. |
| `reconnectMinMs` | `500` | Initial Relay reconnect backoff. |
| `reconnectMaxMs` | `30000` | Maximum Relay reconnect backoff. |
| `approvals` | enabled | Set to `false` to observe only and delegate approval to another answerer. |
| `prependApprovalAnswerer` | enabled | Register before later approval answerers. |
| `requireRelayUrl` | disabled | Throw at startup when neither config nor `STEERLOOP_RELAY_URL` supplies a Relay URL. |
| `requireToken` | disabled | Throw at startup when neither config nor `STEERLOOP_TOKEN` supplies a Relay token. |

## Package verification

From the Steerloop repository root:

```bash
npm run test -w @steerloop/dsh-plugin
npm pack --dry-run -w @steerloop/dsh-plugin
examples/deepseek-harness/smoke-source-checkout.sh
```

## Current limitations

- `session.prompt` and `session.interrupt` are advertised only after a stable
  Harness service seam is selected for them.
- Approval detail is derived from Harness `approval/request` plus the recent
  `tool/call` with the same `callId` when available.
- DeepSeek Harness is a developer preview, so this plugin intentionally uses
  the small public seams `session/event` and `approval/request`.

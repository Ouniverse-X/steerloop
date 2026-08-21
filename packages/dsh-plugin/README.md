# @steerloop/dsh-plugin

`@steerloop/dsh-plugin` connects a DeepSeek Harness runtime to a Steerloop Relay.
It is designed as a thin Cordis plugin so Harness users can keep their existing
`dsh` setup and add mobile/browser observation plus remote approvals.

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

## Cordis configuration

Add the plugin to a Harness `cordis.yml` composition after the session and
approval plugins:

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
| `relayUrl` | `ws://127.0.0.1:8787/ws` | Steerloop Relay WebSocket endpoint. |
| `token` | `STEERLOOP_TOKEN` or `steerloop-local-dev` | Relay shared host token. Use a high-entropy secret remotely. |
| `hostId` | `STEERLOOP_HOST_ID` or OS hostname plus `-dsh` | Stable host identity shown in Steerloop. |
| `hostName` | `STEERLOOP_HOST_NAME` or OS hostname plus ` DeepSeek Harness` | Display name. |
| `pairingCode` | random short code | Browser/mobile pairing code. |
| `pairingTtlMs` | `600000` | Pairing code lifetime. |
| `approvalTimeoutMs` | `300000` | How long a Harness approval waits for a remote decision. |
| `heartbeatMs` | `15000` | Relay heartbeat interval. |
| `requireRelayUrl` | disabled | Throw at startup when neither config nor `STEERLOOP_RELAY_URL` supplies a Relay URL. |
| `requireToken` | disabled | Throw at startup when neither config nor `STEERLOOP_TOKEN` supplies a Relay token. |

## Current limitations

- `session.prompt` and `session.interrupt` are advertised only after a stable
  Harness service seam is selected for them.
- Approval detail is derived from Harness `approval/request` plus the recent
  `tool/call` with the same `callId` when available.
- DeepSeek Harness is a developer preview, so this plugin intentionally uses
  the small public seams `session/event` and `approval/request`.

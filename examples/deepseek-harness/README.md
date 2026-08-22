# DeepSeek Harness examples

These files are patch overlays for DeepSeek Harness profiles. They add
`@steerloop/dsh-plugin` without changing the base Harness composition.

## Install the plugin into a Harness profile

Install the current alpha from npm:

```bash
dsh plugin --profile headless add @steerloop/dsh-plugin@alpha
```

For release-path testing before publication, install the packed tarball into
the profile:

```bash
npm pack -w @steerloop/dsh-plugin
dsh plugin --profile headless add ./steerloop-dsh-plugin-0.1.0-alpha.1.tgz
```

For active local development before publication, install this checkout into the
profile with a file dependency from the Harness profile directory:

```bash
dsh plugin --profile headless add "file:/path/to/steerloop/packages/dsh-plugin"
```

The npm package declares a Harness bundle, so `dsh plugin add` automatically
adds `@steerloop/dsh-plugin` to the profile bundle list. For one-off source
checkout testing without modifying a Harness profile, use
[`source-checkout.cordis.yml`](source-checkout.cordis.yml). It points at this
workspace's plugin source path.

## Local Relay

Start Steerloop:

```bash
npm run dev:relay
npm run dev:web
```

Run Harness with the local Steerloop overlay:

```bash
dsh --profile headless --patch /path/to/steerloop/examples/deepseek-harness/local.cordis.yml "run a quick smoke task"
```

When testing this checkout before installing the package, replace
`local.cordis.yml` with `source-checkout.cordis.yml`.

The plugin prints the pairing code after Relay authentication. Open the
Steerloop web console and pair the browser or phone.

## Remote Relay

Set the remote endpoint and token:

```bash
export STEERLOOP_RELAY_URL="wss://relay.example.com/ws"
export STEERLOOP_TOKEN="use-a-high-entropy-token"
export STEERLOOP_HOST_ID="workstation-dsh"
export STEERLOOP_HOST_NAME="Workstation DeepSeek Harness"
```

Then run:

```bash
dsh --profile headless --patch /path/to/steerloop/examples/deepseek-harness/remote.cordis.yml "continue the long task"
```

## Observe-only mode

Use observe-only mode when another Harness answerer should remain responsible
for approval decisions:

```bash
dsh --profile headless --patch /path/to/steerloop/examples/deepseek-harness/observe-only.cordis.yml "monitor this task only"
```

## Verified smoke

Run the source-checkout smoke from the Steerloop repository:

```bash
examples/deepseek-harness/smoke-source-checkout.sh
examples/deepseek-harness/smoke-tarball-install.sh
examples/deepseek-harness/smoke-approval-e2e.sh
```

This integration was verified against a local Harness checkout using the
Harness-provided Node 24 environment:

```bash
node --version
pnpm --version
```

Observed versions:

```text
v24.19.0
11.7.0
```

Smoke results:

- `dsh --profile headless --patch <tmp patch> --dump-config` included the
  `steerloop` plugin entry.
- `dsh --profile headless --patch <tmp patch> "Steerloop smoke: say hello and stop."`
  loaded the plugin and completed the Harness task.
- With a temporary Relay, the source overlay connected and registered a pairing
  code; Relay logged the corresponding host pairing offer.
- With an isolated temporary `DSH_HOME`, `smoke-tarball-install.sh` packed the
  npm tarball, installed it with `dsh plugin --profile headless add`, verified
  automatic bundle activation, then ran Harness without any extra `--patch`.
- `smoke-approval-e2e.sh` starts real Relay and Harness processes, pairs a
  device, signs approval decisions, verifies approve continues execution, and
  verifies decline leaves the workspace unchanged.

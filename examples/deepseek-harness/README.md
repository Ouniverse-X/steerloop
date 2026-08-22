# DeepSeek Harness examples

These files are patch overlays for DeepSeek Harness profiles. They add
`@steerloop/dsh-plugin` without changing the base Harness composition.

## Install the plugin into a Harness profile

After the package is published:

```bash
source /home/beihang/projects/Harness/dsh-env.sh
dsh plugin --profile headless add @steerloop/dsh-plugin
```

For release-path testing before publication, install the packed tarball into
the profile:

```bash
cd /home/beihang/projects/Steerloop
npm pack -w @steerloop/dsh-plugin
source /home/beihang/projects/Harness/dsh-env.sh
dsh plugin --profile headless add ./steerloop-dsh-plugin-0.1.0.tgz
```

For active local development before publication, install this checkout into the
profile with a file dependency from the Harness profile directory:

```bash
source /home/beihang/projects/Harness/dsh-env.sh
dsh plugin --profile headless add "file:/home/beihang/projects/Steerloop/packages/dsh-plugin"
```

The npm package declares a Harness bundle, so `dsh plugin add` automatically
adds `@steerloop/dsh-plugin` to the profile bundle list. For one-off source
checkout testing without modifying a Harness profile, use
[`source-checkout.cordis.yml`](source-checkout.cordis.yml). It points at this
workspace's plugin source path.

## Local Relay

Start Steerloop:

```bash
cd /home/beihang/projects/Steerloop
npm run dev:relay
npm run dev:web
```

Run Harness with the local Steerloop overlay:

```bash
cd /home/beihang/projects/Harness/deepseek-harness
source /home/beihang/projects/Harness/dsh-env.sh
dsh --profile headless --patch /home/beihang/projects/Steerloop/examples/deepseek-harness/local.cordis.yml "run a quick smoke task"
```

When testing this checkout before installing the package, replace
`local.cordis.yml` with `source-checkout.cordis.yml`.

The plugin prints the pairing code after Relay authentication. Open the
Steerloop web console and pair the browser or phone.

## Remote Relay

Set the remote endpoint and token:

```bash
export STEERLOOP_RELAY_URL="wss://steerloop.example/ws"
export STEERLOOP_TOKEN="replace-with-a-high-entropy-token"
export STEERLOOP_HOST_ID="gpu26-dsh"
export STEERLOOP_HOST_NAME="gpu26 DeepSeek Harness"
```

Then run:

```bash
dsh --profile headless --patch /home/beihang/projects/Steerloop/examples/deepseek-harness/remote.cordis.yml "continue the long task"
```

## Observe-only mode

Use observe-only mode when another Harness answerer should remain responsible
for approval decisions:

```bash
dsh --profile headless --patch /home/beihang/projects/Steerloop/examples/deepseek-harness/observe-only.cordis.yml "monitor this task only"
```

## Verified smoke

Run the source-checkout smoke from the Steerloop repository:

```bash
examples/deepseek-harness/smoke-source-checkout.sh
examples/deepseek-harness/smoke-tarball-install.sh
```

This integration was verified against the local Harness checkout at
`/home/beihang/projects/Harness/deepseek-harness` using the Harness-provided
Node 24 environment:

```bash
source /home/beihang/projects/Harness/dsh-env.sh
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
- With a temporary Relay on port `18887`, the source overlay connected and
  registered pairing code `DSH-2026`; Relay logged the corresponding host
  pairing offer.
- With an isolated temporary `DSH_HOME`, `smoke-tarball-install.sh` packed the
  npm tarball, installed it with `dsh plugin --profile headless add`, verified
  automatic bundle activation, then ran Harness without any extra `--patch`.

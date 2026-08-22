# DSH plugin npm publishing checklist

This checklist tracks what must be true before `@steerloop/dsh-plugin` is
published outside the repository.

## Current package state

- Package: `@steerloop/dsh-plugin`
- Location: `packages/dsh-plugin`
- Entrypoint: `src/index.js`
- Bundle patch: `cordis.patch.yml` via `dsh.bundle.patch`
- Types: `src/index.d.ts`
- Runtime dependency: `ws`
- Node engine: `^22.19.0 || >=24.0.0`
- License field: `MIT`

The package is packable and ready for alpha publication after the checks below
pass.

## Pre-publish checks

Run from the Steerloop repository root:

```bash
npm install
npm run test -w @steerloop/dsh-plugin
npm pack --dry-run -w @steerloop/dsh-plugin
examples/deepseek-harness/smoke-source-checkout.sh
examples/deepseek-harness/smoke-tarball-install.sh
examples/deepseek-harness/smoke-approval-e2e.sh
npm run check
```

The tarball smoke uses a temporary `DSH_HOME`, so it does not mutate the
operator's normal Harness profiles. It verifies that `dsh plugin add` records
`@steerloop/dsh-plugin` as a dependency, activates it as a bundle, and boots
Harness without an extra `--patch`.

## Publication checklist

- Confirm npm authentication with `npm whoami`.
- Confirm package availability with `npm view @steerloop/dsh-plugin`.
- Confirm package ownership for the `@steerloop` npm scope.
- Create a release tag and changelog entry after a successful alpha publish.

## Publish command

For the first alpha release:

```bash
npm publish -w @steerloop/dsh-plugin --access public --tag alpha --registry https://registry.npmjs.org/
```

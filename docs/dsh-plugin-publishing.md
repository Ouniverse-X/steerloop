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
- License field: `UNLICENSED`

The package is technically packable, but public open-source publication should
wait until the repository license is selected.

## Pre-publish checks

Run from the Steerloop repository root:

```bash
npm install
npm run test -w @steerloop/dsh-plugin
npm pack --dry-run -w @steerloop/dsh-plugin
examples/deepseek-harness/smoke-source-checkout.sh
examples/deepseek-harness/smoke-tarball-install.sh
npm run check
```

The tarball smoke uses a temporary `DSH_HOME`, so it does not mutate the
operator's normal Harness profiles. It verifies that `dsh plugin add` records
`@steerloop/dsh-plugin` as a dependency, activates it as a bundle, and boots
Harness without an extra `--patch`.

## Publication blockers

- Select and commit the repository/package license before an open-source npm
  release.
- Decide whether the first published version should remain `0.1.0` or move to
  `0.1.0-alpha.0`.
- Create a release tag and changelog entry.
- Confirm package ownership for the `@steerloop` npm scope.

## Publish command

After blockers are resolved and checks pass:

```bash
npm publish -w @steerloop/dsh-plugin --access public
```

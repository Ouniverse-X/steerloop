# Contributing to Steerloop

Steerloop is security-sensitive software. Prefer small changes with explicit
tests and avoid widening remote capabilities without a written design decision.

## Development workflow

1. Create a short-lived branch from `main`.
2. Keep commits focused and use Conventional Commit messages.
3. Run `npm run check` before pushing.
4. Update protocol documentation when wire behavior changes.
5. Include a threat analysis for authentication, approval, filesystem, or
   command-execution changes.

## Commit format

Examples:

```text
feat(protocol): add approval request envelope
fix(agent): reject expired approval decisions
docs: clarify relay trust boundary
test(relay): cover unauthenticated command rejection
```

## Pull request expectations

- Explain the user-visible outcome.
- Link the relevant roadmap item or issue.
- List the validation performed.
- Call out compatibility and security implications.
- Do not include credentials, real session transcripts, or proprietary code in
  fixtures.

## Architecture decisions

Changes that affect trust boundaries, persistence, the public protocol, or the
provider-adapter contract require an ADR under `docs/adr/`.

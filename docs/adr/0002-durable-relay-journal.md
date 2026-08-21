# ADR 0002: Bounded append-only Relay journal

- Status: accepted
- Date: 2026-08-21

## Context

An in-memory Relay loses the phone's progress view whenever its process or host
restarts. The remote alpha needs deterministic recovery without introducing a
database service or moving authorization state out of the host Agent.

## Decision

The Relay writes validated event envelopes to a local JSONL journal before
broadcasting them. Writes are serialized and synced by default. Startup validates
every complete record, repairs only a crash-truncated final record, and fails on
other corruption. The journal is atomically compacted to the bounded history
window using a same-directory temporary file and rename.

Command frames are not journaled. Pending approval truth remains in the host
Agent; the journal is a replayable view, not an authorization database.

## Consequences

- Relay restarts preserve the latest client snapshot.
- Acknowledged event visibility implies the record was synced when sync mode is
  enabled.
- Journal data is security-sensitive and must be protected and backed up.
- The format is intentionally simple but does not yet provide encryption,
  multi-node replication, or indexed queries.

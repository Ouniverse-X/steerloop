import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  canonicalizeApproval,
  canonicalizeApprovalDecision,
  commandEnvelopeSchema,
  createEmptyState,
  eventEnvelopeSchema,
  reduceEvent,
  type EventEnvelope,
} from "../src/index.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function event(
  sequence: number,
  normalizedEvent: EventEnvelope["event"],
  sessionId?: string,
): EventEnvelope {
  return eventEnvelopeSchema.parse({
    kind: "event",
    protocolVersion: PROTOCOL_VERSION,
    eventId: `event-${sequence}`,
    sequence,
    hostId: "host-1",
    ...(sessionId === undefined ? {} : { sessionId }),
    emittedAt: new Date(sequence * 1_000).toISOString(),
    event: normalizedEvent,
  });
}

describe("wire protocol", () => {
  it("rejects commands outside the remote allowlist", () => {
    const parsed = commandEnvelopeSchema.safeParse({
      kind: "command",
      protocolVersion: PROTOCOL_VERSION,
      commandId: "command-1",
      hostId: "host-1",
      sessionId: "session-1",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      command: {
        type: "shell.execute",
        payload: { command: "rm -rf /" },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("binds approval digests to every security-relevant display field", () => {
    const base = canonicalizeApproval({
      approvalId: "approval-1",
      kind: "command",
      command: "npm test",
      cwd: "/workspace/app",
      reason: "Run the test suite",
      requestedPermissions: ["network:registry.npmjs.org", "write:/workspace/app"],
    });
    const reordered = canonicalizeApproval({
      approvalId: "approval-1",
      kind: "command",
      command: "npm test",
      cwd: "/workspace/app",
      reason: "Run the test suite",
      requestedPermissions: ["write:/workspace/app", "network:registry.npmjs.org"],
    });
    const changed = canonicalizeApproval({
      approvalId: "approval-1",
      kind: "command",
      command: "npm publish",
      cwd: "/workspace/app",
      reason: "Run the test suite",
      requestedPermissions: ["write:/workspace/app", "network:registry.npmjs.org"],
    });

    expect(digest(base)).toBe(digest(reordered));
    expect(digest(base)).not.toBe(digest(changed));
  });

  it("binds approval decision signatures to the device identity", () => {
    const base = canonicalizeApprovalDecision({
      commandId: "command-1",
      hostId: "host-1",
      sessionId: "session-1",
      approvalId: "approval-1",
      requestDigest: "a".repeat(64),
      decision: "approve_once",
      deviceId: "device-1",
      issuedAt: "2026-08-21T00:00:00.000Z",
      expiresAt: "2026-08-21T00:00:30.000Z",
      signedAt: "2026-08-21T00:00:01.000Z",
    });
    const changedDevice = canonicalizeApprovalDecision({
      commandId: "command-1",
      hostId: "host-1",
      sessionId: "session-1",
      approvalId: "approval-1",
      requestDigest: "a".repeat(64),
      decision: "approve_once",
      deviceId: "device-2",
      issuedAt: "2026-08-21T00:00:00.000Z",
      expiresAt: "2026-08-21T00:00:30.000Z",
      signedAt: "2026-08-21T00:00:01.000Z",
    });

    expect(digest(base)).not.toBe(digest(changedDevice));
  });
});

describe("control-plane reducer", () => {
  it("tracks a session through a one-time approval", () => {
    const material = canonicalizeApproval({
      approvalId: "approval-1",
      kind: "command",
      command: "npm test",
      cwd: "/workspace/app",
    });

    const events: EventEnvelope[] = [
      event(1, {
        type: "host.connected",
        payload: {
          name: "Devbox",
          platform: "linux",
          agentVersion: "0.1.0",
          capabilities: ["approval.resolve"],
        },
      }),
      event(
        2,
        {
          type: "session.upserted",
          payload: {
            title: "Fix integration tests",
            source: "codex",
            status: "running",
            cwd: "/workspace/app",
          },
        },
        "session-1",
      ),
      event(
        3,
        {
          type: "approval.requested",
          payload: {
            approvalId: "approval-1",
            kind: "command",
            title: "Run test suite",
            command: "npm test",
            cwd: "/workspace/app",
            requestDigest: digest(material),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          },
        },
        "session-1",
      ),
      event(
        4,
        {
          type: "approval.resolved",
          payload: {
            approvalId: "approval-1",
            decision: "approve_once",
            resolvedAt: new Date().toISOString(),
          },
        },
        "session-1",
      ),
    ];

    const state = events.reduce(reduceEvent, createEmptyState());

    expect(state.hosts["host-1"]?.online).toBe(true);
    expect(state.sessions["session-1"]?.status).toBe("running");
    expect(state.approvals["approval-1"]?.status).toBe("approve_once");
  });

  it("ignores duplicate and out-of-order host events", () => {
    const first = event(2, {
      type: "host.connected",
      payload: {
        name: "Current name",
        platform: "linux",
        agentVersion: "0.1.0",
        capabilities: [],
      },
    });
    const stale = event(1, {
      type: "host.connected",
      payload: {
        name: "Stale name",
        platform: "linux",
        agentVersion: "0.1.0",
        capabilities: [],
      },
    });

    const afterFirst = reduceEvent(createEmptyState(), first);
    expect(reduceEvent(afterFirst, stale)).toBe(afterFirst);
  });

  it("accepts a fresh sequence after the host agent restarts", () => {
    const beforeRestart = [
      event(1, {
        type: "host.connected",
        payload: {
          name: "Devbox",
          platform: "linux",
          agentVersion: "0.1.0",
          capabilities: [],
        },
      }),
      event(
        2,
        {
          type: "session.upserted",
          payload: { title: "Long task", source: "codex", status: "running" },
        },
        "session-before-restart",
      ),
    ].reduce(reduceEvent, createEmptyState());
    const restarted = eventEnvelopeSchema.parse({
      kind: "event",
      protocolVersion: PROTOCOL_VERSION,
      eventId: "event-from-new-agent-process",
      sequence: 1,
      hostId: "host-1",
      emittedAt: new Date(10_000).toISOString(),
      event: {
        type: "host.connected",
        payload: {
          name: "Devbox",
          platform: "linux",
          agentVersion: "0.1.0",
          capabilities: [],
        },
      },
    });

    const state = reduceEvent(beforeRestart, restarted);

    expect(state.hosts["host-1"]?.online).toBe(true);
    expect(state.lastSequenceByHost["host-1"]).toBe(1);
    expect(state.sessions["session-before-restart"]?.status).toBe("offline");
  });
});

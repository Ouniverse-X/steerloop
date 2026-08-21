import { describe, expect, it, vi } from "vitest";
import { SteerloopDshBridge } from "../src/bridge.js";
import { HarnessEventMapper } from "../src/mapping.js";
import { canonicalizeApproval, sha256Hex } from "../src/protocol.js";

describe("DeepSeek Harness mapping", () => {
  it("maps tool calls and approval requests to digest-bound Steerloop approvals", () => {
    const mapper = new HarnessEventMapper();
    const session = { id: "session-1", header: { title: "Harness run" } };
    mapper.mapSessionEvent(session, {
      type: "tool/call",
      data: {
        callId: "call-1",
        name: "bash",
        arguments: JSON.stringify({ command: "npm run check" }),
      },
    });

    const mapped = mapper.createApprovalRequest({
      agent: { session },
      toolName: "bash",
      callId: "call-1",
      reason: "sandbox escalation",
    }, "approval-1", "2026-08-21T00:00:30.000Z");

    expect(mapped).toMatchObject({
      sessionId: "session-1",
      payload: {
        approvalId: "approval-1",
        kind: "command",
        title: "Approve bash",
        command: "npm run check",
        requestedPermissions: ["tool:bash", "call:call-1"],
      },
    });
    const material = canonicalizeApproval({
      approvalId: "approval-1",
      kind: "command",
      title: "Approve bash",
      reason: "sandbox escalation",
      command: "npm run check",
      requestedPermissions: ["tool:bash", "call:call-1"],
    });
    expect(mapped.payload.requestDigest).toBe(sha256Hex(material));
  });

  it("resolves a pending Harness approval from a Steerloop approval command", async () => {
    vi.useFakeTimers();
    const bridge = new SteerloopDshBridge({
      hostId: "host-1",
      approvalTimeoutMs: 30_000,
    });
    const published = [];
    bridge.publish = (frame) => {
      published.push(frame);
    };
    const request = bridge.requestApproval({
      agent: { session: { id: "session-1", header: { title: "Harness run" } } },
      toolName: "bash",
      reason: "needs permission",
    });
    const approvalEvent = published.find((frame) => frame.event?.type === "approval.requested");
    expect(approvalEvent).toBeDefined();

    bridge.handleCommand({
      kind: "command",
      protocolVersion: "0.1.0",
      commandId: "command-1",
      hostId: "host-1",
      sessionId: "session-1",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      command: {
        type: "approval.resolve",
        payload: {
          approvalId: approvalEvent.event.payload.approvalId,
          requestDigest: approvalEvent.event.payload.requestDigest,
          decision: "approve_once",
        },
      },
    });

    await expect(request).resolves.toBe("allowed-once");
    expect(published).toContainEqual(expect.objectContaining({
      kind: "command.result",
      commandId: "command-1",
      ok: true,
    }));
    vi.useRealTimers();
  });
});

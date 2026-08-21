import { createHash, webcrypto } from "node:crypto";
import { canonicalizeApproval, type ApprovalView } from "@steerloop/protocol";
import { describe, expect, it } from "vitest";
import { verifyApprovalIntegrity } from "../src/approval-integrity.js";

function approval(): ApprovalView {
  const material = {
    approvalId: "approval-1",
    kind: "command" as const,
    command: "npm run check",
    cwd: "/workspace/steerloop",
    reason: "Validate the milestone",
  };
  return {
    id: material.approvalId,
    hostId: "host-1",
    sessionId: "session-1",
    kind: material.kind,
    title: "Run checks",
    command: material.command,
    cwd: material.cwd,
    reason: material.reason,
    requestDigest: createHash("sha256")
      .update(canonicalizeApproval(material))
      .digest("hex"),
    expiresAt: "2026-08-21T01:00:00.000Z",
    requestedAt: "2026-08-21T00:00:00.000Z",
    status: "pending",
  };
}

describe("approval integrity", () => {
  it("accepts display data that matches the host-bound digest", async () => {
    await expect(
      verifyApprovalIntegrity(approval(), webcrypto.subtle as unknown as SubtleCrypto),
    ).resolves.toBe("valid");
  });

  it("rejects relay-tampered display data", async () => {
    const tampered = { ...approval(), command: "rm -rf important-data" };
    await expect(
      verifyApprovalIntegrity(tampered, webcrypto.subtle as unknown as SubtleCrypto),
    ).resolves.toBe("invalid");
  });
});

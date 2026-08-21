import { canonicalizeApproval, type ApprovalView } from "@steerloop/protocol";

export type ApprovalIntegrity = "checking" | "valid" | "invalid" | "unavailable";

function approvalMaterial(approval: ApprovalView): string {
  return canonicalizeApproval({
    approvalId: approval.id,
    kind: approval.kind,
    ...(approval.command === undefined ? {} : { command: approval.command }),
    ...(approval.cwd === undefined ? {} : { cwd: approval.cwd }),
    ...(approval.grantRoot === undefined ? {} : { grantRoot: approval.grantRoot }),
    ...(approval.networkHost === undefined ? {} : { networkHost: approval.networkHost }),
    ...(approval.networkProtocol === undefined
      ? {}
      : { networkProtocol: approval.networkProtocol }),
    ...(approval.reason === undefined ? {} : { reason: approval.reason }),
    ...(approval.requestedPermissions === undefined
      ? {}
      : { requestedPermissions: approval.requestedPermissions }),
  });
}

export async function verifyApprovalIntegrity(
  approval: ApprovalView,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<ApprovalIntegrity> {
  if (subtle === undefined) return "unavailable";
  const bytes = new TextEncoder().encode(approvalMaterial(approval));
  const digest = await subtle.digest("SHA-256", bytes);
  const actual = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return actual === approval.requestDigest ? "valid" : "invalid";
}

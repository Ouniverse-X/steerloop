import type { ApprovalKind } from "./schema.js";

export interface ApprovalDigestMaterial {
  approvalId: string;
  kind: ApprovalKind;
  command?: string;
  cwd?: string;
  grantRoot?: string;
  networkHost?: string;
  networkProtocol?: string;
  reason?: string;
  requestedPermissions?: string[];
}

function normalizedOptional(value: string | undefined): string | null {
  return value === undefined ? null : value.normalize("NFC");
}

/**
 * Produces a stable representation for host-side approval binding.
 *
 * The digest itself is calculated by the host adapter with SHA-256. Keeping the
 * canonical representation in the cross-runtime package lets browser clients
 * independently verify what they are about to approve later.
 */
export function canonicalizeApproval(material: ApprovalDigestMaterial): string {
  return JSON.stringify({
    approvalId: material.approvalId.normalize("NFC"),
    kind: material.kind,
    command: normalizedOptional(material.command),
    cwd: normalizedOptional(material.cwd),
    grantRoot: normalizedOptional(material.grantRoot),
    networkHost: normalizedOptional(material.networkHost),
    networkProtocol: normalizedOptional(material.networkProtocol),
    reason: normalizedOptional(material.reason),
    requestedPermissions: [...(material.requestedPermissions ?? [])]
      .map((permission) => permission.normalize("NFC"))
      .sort(),
  });
}

export interface ApprovalDecisionSignatureMaterial {
  commandId: string;
  hostId: string;
  sessionId: string;
  approvalId: string;
  requestDigest: string;
  decision: string;
  deviceId: string;
  issuedAt: string;
  expiresAt: string;
  signedAt: string;
}

export function canonicalizeApprovalDecision(
  material: ApprovalDecisionSignatureMaterial,
): string {
  return JSON.stringify({
    commandId: material.commandId.normalize("NFC"),
    hostId: material.hostId.normalize("NFC"),
    sessionId: material.sessionId.normalize("NFC"),
    approvalId: material.approvalId.normalize("NFC"),
    requestDigest: material.requestDigest.normalize("NFC"),
    decision: material.decision,
    deviceId: material.deviceId.normalize("NFC"),
    issuedAt: material.issuedAt,
    expiresAt: material.expiresAt,
    signedAt: material.signedAt,
  });
}

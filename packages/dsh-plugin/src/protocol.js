import { createHash, randomBytes } from "node:crypto";

export const PROTOCOL_VERSION = "0.1.0";

export function canonicalizeApproval(material) {
  const normalizedOptional = (value) => typeof value === "string" ? value.normalize("NFC") : null;
  return JSON.stringify({
    approvalId: String(material.approvalId).normalize("NFC"),
    kind: String(material.kind),
    command: normalizedOptional(material.command),
    cwd: normalizedOptional(material.cwd),
    grantRoot: normalizedOptional(material.grantRoot),
    networkHost: normalizedOptional(material.networkHost),
    networkProtocol: normalizedOptional(material.networkProtocol),
    reason: normalizedOptional(material.reason),
    requestedPermissions: Array.isArray(material.requestedPermissions)
      ? [...material.requestedPermissions].map((permission) => String(permission).normalize("NFC")).sort()
      : [],
  });
}


export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function randomPairingCode() {
  return randomBytes(4).toString("hex").toUpperCase().replace(/^(.{4})(.{4})$/, "$1-$2");
}

export function normalizeDecision(decision) {
  switch (decision) {
    case "approve_once":
      return "allowed-once";
    case "decline":
      return "rejected";
    case "cancel":
      return "cancelled";
    default:
      return "unavailable";
  }
}

import { createHash, randomBytes } from "node:crypto";

export const PROTOCOL_VERSION = "0.1.0";

export function canonicalizeApproval(material) {
  return JSON.stringify({
    approvalId: String(material.approvalId).normalize("NFC"),
    kind: String(material.kind),
    title: String(material.title).normalize("NFC"),
    reason: typeof material.reason === "string" ? material.reason.normalize("NFC") : undefined,
    command: typeof material.command === "string" ? material.command.normalize("NFC") : undefined,
    cwd: typeof material.cwd === "string" ? material.cwd.normalize("NFC") : undefined,
    grantRoot: typeof material.grantRoot === "string" ? material.grantRoot.normalize("NFC") : undefined,
    networkHost: typeof material.networkHost === "string" ? material.networkHost.normalize("NFC") : undefined,
    networkProtocol: typeof material.networkProtocol === "string" ? material.networkProtocol.normalize("NFC") : undefined,
    requestedPermissions: Array.isArray(material.requestedPermissions)
      ? [...material.requestedPermissions].map((permission) => String(permission).normalize("NFC")).sort()
      : undefined,
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

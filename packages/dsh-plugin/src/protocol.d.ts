export const PROTOCOL_VERSION: "0.1.0";
export function canonicalizeApproval(material: Record<string, unknown>): string;
export function sha256Hex(value: string): string;
export function randomPairingCode(): string;
export function normalizeDecision(decision: unknown): "allowed-once" | "rejected" | "cancelled" | "unavailable";

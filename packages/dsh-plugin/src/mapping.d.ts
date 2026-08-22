export interface MappedHarnessEvent {
  sessionId: string;
  event: unknown;
}

export interface MappedApprovalRequest {
  sessionId: string;
  payload: {
    approvalId: string;
    kind: "command" | "permissions";
    title: string;
    reason?: string;
    command?: string;
    requestedPermissions: string[];
    requestDigest: string;
    expiresAt: string;
  };
}

export class HarnessEventMapper {
  constructor();
  rememberToolCall(sessionId: string, data: Record<string, unknown>): void;
  findToolCall(sessionId: string, callId: unknown): unknown;
  mapSessionEvent(session: unknown, event: unknown): MappedHarnessEvent[];
  createApprovalRequest(req: { agent?: { session?: unknown }; toolName?: string; callId?: string; reason?: string }, approvalId: string, expiresAt: string): MappedApprovalRequest;
}

export interface SteerloopDshConfig {
  relayUrl?: string;
  token?: string;
  hostId?: string;
  hostName?: string;
  pairingCode?: string;
  pairingTtlMs?: number;
  approvalTimeoutMs?: number;
  heartbeatMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  approvals?: boolean;
  prependApprovalAnswerer?: boolean;
  requireRelayUrl?: boolean;
  requireToken?: boolean;
}

export interface HarnessApprovalRequest {
  agent?: { session?: unknown };
  toolName?: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

export type HarnessApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export class SteerloopDshBridge {
  constructor(config?: SteerloopDshConfig);
  start(): void;
  stop(): Promise<void>;
  handleSessionEvent(session: unknown, event: unknown): void;
  requestApproval(req: HarnessApprovalRequest): Promise<HarnessApprovalOutcome>;
  publishEvent(sessionId: string | undefined, event: unknown): void;
  publish(frame: unknown): void;
  connect(): void;
  handleRelayFrame(raw: string): void;
  handleCommand(command: unknown): void;
}

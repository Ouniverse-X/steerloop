import type { CommandEnvelope, NormalizedEvent } from "@steerloop/protocol";

export interface AdapterContext {
  hostId: string;
  emit(sessionId: string | undefined, event: NormalizedEvent): void;
}

export interface AgentAdapter {
  readonly name: string;
  readonly capabilities: string[];
  start(context: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  handleCommand(command: CommandEnvelope): Promise<void>;
}

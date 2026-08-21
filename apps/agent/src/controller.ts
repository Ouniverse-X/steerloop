import { PROTOCOL_VERSION, type CommandEnvelope } from "@steerloop/protocol";
import type { AgentConfig } from "./config.js";
import { EventFactory } from "./event-factory.js";
import { RelayClient } from "./relay-client.js";
import type { AgentAdapter } from "./types.js";

export class AgentController {
  private readonly eventFactory: EventFactory;
  private readonly relay: RelayClient;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: AgentConfig,
    private readonly adapter: AgentAdapter,
  ) {
    this.eventFactory = new EventFactory(config.hostId);
    this.relay = new RelayClient({
      url: config.relayUrl,
      token: config.token,
      hostId: config.hostId,
      reconnectMinMs: config.reconnectMinMs,
      reconnectMaxMs: config.reconnectMaxMs,
      onCommand: (command) => this.handleCommand(command),
    });
  }

  async start(): Promise<void> {
    await this.relay.start();
    this.relay.publish(
      this.eventFactory.create(undefined, {
        type: "host.connected",
        payload: {
          name: this.config.hostName,
          platform: this.config.platform,
          agentVersion: PROTOCOL_VERSION,
          capabilities: this.adapter.capabilities,
        },
      }),
    );
    await this.adapter.start({
      hostId: this.config.hostId,
      emit: (sessionId, event) => {
        this.relay.publish(this.eventFactory.create(sessionId, event));
      },
    });
    this.heartbeat = setInterval(() => {
      this.relay.publish(
        this.eventFactory.create(undefined, {
          type: "host.heartbeat",
          payload: { at: new Date().toISOString() },
        }),
      );
    }, this.config.heartbeatMs);
  }

  async stop(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    await this.adapter.stop();
    this.relay.publish(
      this.eventFactory.create(undefined, {
        type: "host.disconnected",
        payload: { reason: "Agent stopped" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await this.relay.stop();
  }

  private async handleCommand(command: CommandEnvelope): Promise<void> {
    await this.adapter.handleCommand(command);
  }
}

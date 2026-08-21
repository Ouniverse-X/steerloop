import {
  PROTOCOL_VERSION,
  relayToAgentFrameSchema,
  type CommandEnvelope,
  type CommandResult,
  type EventEnvelope,
  type PairingOfferFrame,
} from "@steerloop/protocol";
import { WebSocket } from "ws";

interface RelayClientOptions {
  url: string;
  token: string;
  hostId: string;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  onAuthenticated?(): void;
  onCommand(command: CommandEnvelope): Promise<void>;
}

type OutboundFrame = EventEnvelope | CommandResult;
type AuthenticatedFrame = OutboundFrame | PairingOfferFrame;

const MAX_QUEUE = 1_000;

export class RelayClient {
  private socket: WebSocket | undefined;
  private authenticated = false;
  private stopped = false;
  private reconnectDelayMs: number;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private queue: AuthenticatedFrame[] = [];

  constructor(private readonly options: RelayClientOptions) {
    this.reconnectDelayMs = options.reconnectMinMs;
  }

  async start(): Promise<void> {
    this.stopped = false;
    void this.connectOnce().catch(() => this.scheduleReconnect());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = undefined;
    this.authenticated = false;
    if (socket === undefined) return;
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.once("close", () => resolve());
      socket.close(1000, "agent shutting down");
      setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        resolve();
      }, 1_000).unref();
    });
  }

  publish(frame: AuthenticatedFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      this.socket.send(JSON.stringify(frame));
      return;
    }
    this.queue = [...this.queue, frame].slice(-MAX_QUEUE);
  }

  private flushQueue(): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.authenticated) return;
    for (const frame of this.queue) this.socket.send(JSON.stringify(frame));
    this.queue = [];
  }

  private async connectOnce(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.options.url, { maxPayload: 512 * 1_024 });
      this.socket = socket;
      let ready = false;

      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            kind: "auth",
            protocolVersion: PROTOCOL_VERSION,
            role: "agent",
            token: this.options.token,
            hostId: this.options.hostId,
          }),
        );
      });

      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        let value: unknown;
        try {
          value = JSON.parse(data.toString());
        } catch {
          socket.close(1007, "invalid relay JSON");
          return;
        }

        const parsed = relayToAgentFrameSchema.safeParse(value);
        if (!parsed.success) {
          socket.close(1008, "invalid relay frame");
          return;
        }

        if (parsed.data.kind === "auth.result") {
          if (!parsed.data.ok) {
            reject(new Error(parsed.data.error ?? "Relay authentication failed"));
            socket.close(1008, "authentication failed");
            return;
          }
          ready = true;
          this.authenticated = true;
          this.reconnectDelayMs = this.options.reconnectMinMs;
          this.flushQueue();
          this.options.onAuthenticated?.();
          resolve();
          return;
        }

        void this.handleCommand(parsed.data);
      });

      socket.once("error", (error) => {
        if (!ready) reject(error);
      });

      socket.once("close", () => {
        this.authenticated = false;
        if (!ready) reject(new Error("Relay closed before authentication"));
        if (!this.stopped) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.stopped) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      this.options.reconnectMaxMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectOnce().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private async handleCommand(command: CommandEnvelope): Promise<void> {
    let result: CommandResult;
    try {
      if (Date.parse(command.expiresAt) <= Date.now()) {
        throw new Error("Command has expired");
      }
      if (command.hostId !== this.options.hostId) {
        throw new Error("Host identity mismatch");
      }
      await this.options.onCommand(command);
      result = {
        kind: "command.result",
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        hostId: this.options.hostId,
        ok: true,
      };
    } catch (error) {
      result = {
        kind: "command.result",
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        hostId: this.options.hostId,
        ok: false,
        error: error instanceof Error ? error.message : "Unknown agent error",
      };
    }
    this.publish(result);
  }
}

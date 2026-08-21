import {
  PROTOCOL_VERSION,
  commandEnvelopeSchema,
  createEmptyState,
  reduceEvent,
  reduceEvents,
  relayToClientFrameSchema,
  type CommandEnvelope,
  type CommandResult,
  type ControlPlaneState,
  type NormalizedCommand,
} from "@steerloop/protocol";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface ConnectionUpdate {
  status: ConnectionStatus;
  detail?: string;
}

interface ControlClientCallbacks {
  onState(state: ControlPlaneState): void;
  onConnection(update: ConnectionUpdate): void;
  onCommandResult(result: CommandResult): void;
}

interface ConnectionTarget {
  url: string;
  token: string;
}

const RECONNECT_MIN_MS = 750;
const RECONNECT_MAX_MS = 10_000;

function commandId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function buildCommand(
  hostId: string,
  sessionId: string,
  command: NormalizedCommand,
  now = Date.now(),
  id = commandId(),
): CommandEnvelope {
  return commandEnvelopeSchema.parse({
    kind: "command",
    protocolVersion: PROTOCOL_VERSION,
    commandId: id,
    hostId,
    sessionId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    command,
  });
}

export function defaultRelayUrl(
  location: Pick<Location, "host" | "protocol">,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

export class ControlClient {
  private socket: WebSocket | undefined;
  private target: ConnectionTarget | undefined;
  private reconnectTimer: number | undefined;
  private reconnectDelay = RECONNECT_MIN_MS;
  private shouldReconnect = false;
  private authenticated = false;
  private state = createEmptyState();

  constructor(private readonly callbacks: ControlClientCallbacks) {}

  connect(target: ConnectionTarget): void {
    this.disconnect();
    this.target = target;
    this.shouldReconnect = true;
    this.open("connecting");
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.authenticated = false;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "client disconnecting");
    }
    this.callbacks.onConnection({ status: "disconnected" });
  }

  send(command: CommandEnvelope): void {
    if (!this.authenticated || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Relay is not connected");
    }
    this.socket.send(JSON.stringify(commandEnvelopeSchema.parse(command)));
  }

  private open(status: "connecting" | "reconnecting"): void {
    const target = this.target;
    if (target === undefined || !this.shouldReconnect) return;
    this.callbacks.onConnection({ status });

    let socket: WebSocket;
    try {
      socket = new WebSocket(target.url);
    } catch (error) {
      this.callbacks.onConnection({
        status: "error",
        detail: error instanceof Error ? error.message : "Invalid relay URL",
      });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          kind: "auth",
          protocolVersion: PROTOCOL_VERSION,
          role: "client",
          token: target.token,
        }),
      );
    });

    socket.addEventListener("message", (event) => this.handleMessage(socket, event.data));
    socket.addEventListener("error", () => {
      if (this.socket === socket) {
        this.callbacks.onConnection({
          status: "error",
          detail: "Could not reach the relay",
        });
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.authenticated = false;
      if (this.shouldReconnect) this.scheduleReconnect();
    });
  }

  private handleMessage(socket: WebSocket, data: unknown): void {
    if (this.socket !== socket || typeof data !== "string") return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      socket.close(1007, "invalid relay JSON");
      return;
    }

    const parsed = relayToClientFrameSchema.safeParse(value);
    if (!parsed.success) {
      socket.close(1008, "invalid relay frame");
      return;
    }

    const frame = parsed.data;
    switch (frame.kind) {
      case "auth.result":
        if (!frame.ok) {
          this.shouldReconnect = false;
          this.callbacks.onConnection({
            status: "error",
            detail: frame.error ?? "Relay authentication failed",
          });
          socket.close(1008, "authentication failed");
          return;
        }
        this.authenticated = true;
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.callbacks.onConnection({ status: "connected" });
        return;
      case "snapshot":
        this.state = reduceEvents(frame.events);
        this.callbacks.onState(this.state);
        return;
      case "event":
        this.state = reduceEvent(this.state, frame);
        this.callbacks.onState(this.state);
        return;
      case "command.result":
        this.callbacks.onCommandResult(frame);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || !this.shouldReconnect) return;
    this.callbacks.onConnection({ status: "reconnecting" });
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open("reconnecting");
    }, delay);
  }
}

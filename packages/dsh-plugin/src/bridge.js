import { hostname, platform } from "node:os";
import { WebSocket } from "ws";
import { HarnessEventMapper } from "./mapping.js";
import { PROTOCOL_VERSION, normalizeDecision, randomPairingCode } from "./protocol.js";

const DEFAULTS = {
  relayUrl: "ws://127.0.0.1:8787/ws",
  token: "steerloop-local-dev",
  heartbeatMs: 15_000,
  reconnectMinMs: 500,
  reconnectMaxMs: 30_000,
  pairingTtlMs: 10 * 60_000,
  approvalTimeoutMs: 5 * 60_000,
};

export class SteerloopDshBridge {
  constructor(config = {}) {
    const host = hostname();
    if (config.requireToken === true && config.token === undefined && process.env.STEERLOOP_TOKEN === undefined) {
      throw new Error("STEERLOOP_TOKEN or config.token is required");
    }
    if (config.requireRelayUrl === true && config.relayUrl === undefined && process.env.STEERLOOP_RELAY_URL === undefined) {
      throw new Error("STEERLOOP_RELAY_URL or config.relayUrl is required");
    }
    const token = config.token ?? process.env.STEERLOOP_TOKEN ?? DEFAULTS.token;
    this.config = {
      ...DEFAULTS,
      ...config,
      relayUrl: config.relayUrl ?? process.env.STEERLOOP_RELAY_URL ?? DEFAULTS.relayUrl,
      token,
      hostId: config.hostId ?? process.env.STEERLOOP_HOST_ID ?? `${host}-dsh`,
      hostName: config.hostName ?? process.env.STEERLOOP_HOST_NAME ?? `${host} DeepSeek Harness`,
      pairingCode: config.pairingCode ?? process.env.STEERLOOP_PAIRING_CODE ?? randomPairingCode(),
    };
    this.mapper = new HarnessEventMapper();
    this.pendingApprovals = new Map();
    this.queue = [];
    this.sequence = 0;
    this.stopped = false;
    this.authenticated = false;
    this.reconnectDelayMs = this.config.reconnectMinMs;
  }

  start() {
    this.stopped = false;
    console.log(`[steerloop-dsh] connecting ${this.config.hostId} to ${this.config.relayUrl}`);
    this.connect();
    this.heartbeat = setInterval(() => {
      this.publishEvent(undefined, {
        type: "host.heartbeat",
        payload: { at: new Date().toISOString() },
      });
    }, this.config.heartbeatMs);
  }

  async stop() {
    this.stopped = true;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.publishEvent(undefined, {
      type: "host.disconnected",
      payload: { reason: "DeepSeek Harness plugin stopped" },
    });
    const socket = this.socket;
    this.socket = undefined;
    this.authenticated = false;
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "dsh plugin shutting down");
    }
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve("unavailable");
    }
    this.pendingApprovals.clear();
  }

  handleSessionEvent(session, event) {
    for (const frame of this.mapper.mapSessionEvent(session, event)) {
      this.publishEvent(frame.sessionId, frame.event);
    }
  }

  requestApproval(req) {
    const approvalId = `dsh-${cryptoRandomId()}`;
    const expiresAt = new Date(Date.now() + this.config.approvalTimeoutMs).toISOString();
    const mapped = this.mapper.createApprovalRequest(req, approvalId, expiresAt);
    this.publishEvent(mapped.sessionId, {
      type: "session.status.changed",
      payload: { status: "waiting_approval" },
    });
    this.publishEvent(mapped.sessionId, {
      type: "approval.requested",
      payload: mapped.payload,
    });
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(approvalId);
        this.publishEvent(mapped.sessionId, {
          type: "approval.resolved",
          payload: {
            approvalId,
            decision: "cancel",
            resolvedAt: new Date().toISOString(),
          },
        });
        resolve("unavailable");
      }, this.config.approvalTimeoutMs);
      this.pendingApprovals.set(approvalId, {
        sessionId: mapped.sessionId,
        requestDigest: mapped.payload.requestDigest,
        resolve: (outcome) => {
          clearTimeout(timeout);
          resolve(outcome);
        },
      });
    });
  }

  publishEvent(sessionId, event) {
    this.publish({
      kind: "event",
      protocolVersion: PROTOCOL_VERSION,
      eventId: `dsh-event-${Date.now()}-${this.sequence + 1}`,
      sequence: ++this.sequence,
      hostId: this.config.hostId,
      ...(sessionId === undefined ? {} : { sessionId }),
      emittedAt: new Date().toISOString(),
      event,
    });
  }

  publish(frame) {
    if (this.socket?.readyState === WebSocket.OPEN && this.authenticated) {
      this.socket.send(JSON.stringify(frame));
      return;
    }
    this.queue = [...this.queue, frame].slice(-1_000);
  }

  connect() {
    const socket = new WebSocket(this.config.relayUrl, { maxPayload: 512 * 1_024 });
    this.socket = socket;

    socket.once("open", () => {
      socket.send(JSON.stringify({
        kind: "auth",
        protocolVersion: PROTOCOL_VERSION,
        role: "agent",
        token: this.config.token,
        hostId: this.config.hostId,
      }));
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.handleRelayFrame(data.toString());
    });

    socket.once("close", () => {
      this.authenticated = false;
      if (!this.stopped) this.scheduleReconnect();
    });

    socket.once("error", () => {
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  handleRelayFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.socket?.close(1007, "invalid relay JSON");
      return;
    }
    if (frame.kind === "auth.result") {
      if (frame.ok !== true) {
        this.socket?.close(1008, "relay authentication failed");
        return;
      }
      this.authenticated = true;
      this.reconnectDelayMs = this.config.reconnectMinMs;
      this.publishEvent(undefined, {
        type: "host.connected",
        payload: {
          name: this.config.hostName,
          platform: platform(),
          agentVersion: PROTOCOL_VERSION,
          capabilities: ["approval.resolve"],
        },
      });
      this.publish({
        kind: "pairing.offer",
        protocolVersion: PROTOCOL_VERSION,
        hostId: this.config.hostId,
        code: this.config.pairingCode,
        expiresAt: new Date(Date.now() + this.config.pairingTtlMs).toISOString(),
      });
      console.log(`[steerloop-dsh] pairing code ${this.config.pairingCode} registered for ${this.config.hostId}`);
      this.flushQueue();
      return;
    }
    if (frame.kind === "command") {
      this.handleCommand(frame);
    }
  }

  handleCommand(command) {
    let ok = true;
    let error;
    try {
      if (Date.parse(command.expiresAt) <= Date.now()) throw new Error("Command has expired");
      if (command.hostId !== this.config.hostId) throw new Error("Host identity mismatch");
      if (command.command?.type !== "approval.resolve") throw new Error("Unsupported DeepSeek Harness command");
      this.resolveApproval(command);
    } catch (caught) {
      ok = false;
      error = caught instanceof Error ? caught.message : "Unknown command error";
    }
    this.publish({
      kind: "command.result",
      protocolVersion: PROTOCOL_VERSION,
      commandId: command.commandId,
      hostId: this.config.hostId,
      ok,
      ...(error === undefined ? {} : { error }),
    });
  }

  resolveApproval(command) {
    const payload = command.command.payload;
    const pending = this.pendingApprovals.get(payload.approvalId);
    if (pending === undefined) throw new Error("Approval is no longer pending");
    if (pending.requestDigest !== payload.requestDigest) throw new Error("Approval digest mismatch");
    this.pendingApprovals.delete(payload.approvalId);
    const outcome = normalizeDecision(payload.decision);
    pending.resolve(outcome);
    this.publishEvent(pending.sessionId, {
      type: "approval.resolved",
      payload: {
        approvalId: payload.approvalId,
        decision: payload.decision,
        resolvedAt: new Date().toISOString(),
      },
    });
    this.publishEvent(pending.sessionId, {
      type: "session.status.changed",
      payload: { status: "running" },
    });
  }

  flushQueue() {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.authenticated) return;
    for (const frame of this.queue) this.socket.send(JSON.stringify(frame));
    this.queue = [];
  }

  scheduleReconnect() {
    if (this.reconnectTimer !== undefined || this.stopped) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.config.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

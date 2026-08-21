import {
  PROTOCOL_VERSION,
  relayToClientFrameSchema,
  type ApprovalView,
  type EventEnvelope,
  type RelayToClientFrame,
} from "@steerloop/protocol";
import { describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createRelayServer } from "../../relay/src/server.js";
import { AgentController } from "../src/controller.js";
import { DemoAdapter } from "../src/demo-adapter.js";

const TOKEN = "round-trip-test-token";

class FrameInbox {
  private readonly frames: RelayToClientFrame[] = [];
  private readonly waiters: Array<(frame: RelayToClientFrame) => void> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data: RawData) => {
      const frame = relayToClientFrameSchema.parse(JSON.parse(data.toString()));
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.frames.push(frame);
      else waiter(frame);
    });
  }

  next(): Promise<RelayToClientFrame> {
    const frame = this.frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async event(type: EventEnvelope["event"]["type"]): Promise<EventEnvelope> {
    for (let index = 0; index < 30; index += 1) {
      const frame = await this.next();
      if (frame.kind === "event" && frame.event.type === type) return frame;
    }
    throw new Error(`Did not receive ${type}`);
  }
}

async function openClient(port: number): Promise<{ socket: WebSocket; inbox: FrameInbox }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = new FrameInbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "auth",
      protocolVersion: PROTOCOL_VERSION,
      role: "client",
      token: TOKEN,
    }),
  );
  expect(await inbox.next()).toMatchObject({ kind: "auth.result", ok: true });
  expect(await inbox.next()).toMatchObject({ kind: "snapshot", events: [] });
  return { socket, inbox };
}

describe("local approval round trip", () => {
  it("carries an approval from the host to a client and returns its decision", async () => {
    const relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      authTimeoutMs: 1_000,
      maxHistory: 100,
      maxPayloadBytes: 64 * 1_024,
    });
    const port = await relay.start();
    const { socket, inbox } = await openClient(port);
    const controller = new AgentController(
      {
        relayUrl: `ws://127.0.0.1:${port}/ws`,
        token: TOKEN,
        hostId: "round-trip-host",
        hostName: "Round Trip Host",
        platform: "test",
        adapter: "demo",
        codexCommand: "codex",
        heartbeatMs: 60_000,
        reconnectMinMs: 20,
        reconnectMaxMs: 100,
        pairingCode: "TEST-PAIR",
        pairingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      new DemoAdapter({ approvalDelayMs: 5, completionDelayMs: 5 }),
    );

    try {
      await controller.start();
      const requested = await inbox.event("approval.requested");
      if (requested.event.type !== "approval.requested" || requested.sessionId === undefined) {
        throw new Error("Unexpected approval event");
      }
      const approval: Pick<ApprovalView, "id" | "requestDigest"> = {
        id: requested.event.payload.approvalId,
        requestDigest: requested.event.payload.requestDigest,
      };

      socket.send(
        JSON.stringify({
          kind: "command",
          protocolVersion: PROTOCOL_VERSION,
          commandId: "approve-command",
          hostId: requested.hostId,
          sessionId: requested.sessionId,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          command: {
            type: "approval.resolve",
            payload: {
              approvalId: approval.id,
              requestDigest: approval.requestDigest,
              decision: "approve_once",
            },
          },
        }),
      );

      const resolved = await inbox.event("approval.resolved");
      expect(resolved.event).toMatchObject({
        payload: { approvalId: approval.id, decision: "approve_once" },
      });
      const completed = await inbox.event("session.status.changed");
      expect(completed.event).toMatchObject({ payload: { status: "completed" } });
    } finally {
      await controller.stop();
      socket.terminate();
      await relay.stop();
    }
  });
});

import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type EventEnvelope,
} from "@steerloop/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer, type RelayServer } from "../src/server.js";

const TOKEN = "test-token-with-enough-entropy";
const openServers: RelayServer[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate();
  for (const server of openServers.splice(0)) await server.stop();
});

async function startRelay(): Promise<number> {
  const server = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    authTimeoutMs: 1_000,
    maxHistory: 50,
    maxPayloadBytes: 64 * 1_024,
  });
  openServers.push(server);
  return server.start();
}

async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextFrames(socket: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const frames: unknown[] = [];
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    const onMessage = (data: WebSocket.RawData) => {
      try {
        frames.push(JSON.parse(data.toString()));
        if (frames.length === count) {
          socket.off("error", onError);
          socket.off("message", onMessage);
          resolve(frames);
        }
      } catch (error) {
        socket.off("error", onError);
        socket.off("message", onMessage);
        reject(error);
      }
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

async function nextFrame(socket: WebSocket): Promise<unknown> {
  return (await nextFrames(socket, 1))[0];
}

async function authenticateClient(socket: WebSocket): Promise<void> {
  const frames = nextFrames(socket, 2);
  socket.send(
    JSON.stringify({
      kind: "auth",
      protocolVersion: PROTOCOL_VERSION,
      role: "client",
      token: TOKEN,
    }),
  );
  const [authResult, snapshot] = await frames;
  expect(authResult).toMatchObject({ kind: "auth.result", ok: true });
  expect(snapshot).toMatchObject({ kind: "snapshot", events: [] });
}

async function authenticateAgent(socket: WebSocket): Promise<void> {
  const authResult = nextFrame(socket);
  socket.send(
    JSON.stringify({
      kind: "auth",
      protocolVersion: PROTOCOL_VERSION,
      role: "agent",
      token: TOKEN,
      hostId: "host-1",
    }),
  );
  expect(await authResult).toMatchObject({ kind: "auth.result", ok: true });
}

describe("relay", () => {
  it("authenticates peers and forwards host events", async () => {
    const port = await startRelay();
    const client = await connect(port);
    await authenticateClient(client);
    const agent = await connect(port);
    await authenticateAgent(agent);

    const event: EventEnvelope = {
      kind: "event",
      protocolVersion: PROTOCOL_VERSION,
      eventId: "event-1",
      sequence: 1,
      hostId: "host-1",
      emittedAt: new Date().toISOString(),
      event: {
        type: "host.connected",
        payload: {
          name: "Test host",
          platform: "linux",
          agentVersion: "0.1.0",
          capabilities: [],
        },
      },
    };
    const forwarded = nextFrame(client);
    agent.send(JSON.stringify(event));

    await expect(forwarded).resolves.toEqual(event);
  });

  it("forwards only valid, unexpired commands to the selected host", async () => {
    const port = await startRelay();
    const client = await connect(port);
    await authenticateClient(client);
    const agent = await connect(port);
    await authenticateAgent(agent);

    const command: CommandEnvelope = {
      kind: "command",
      protocolVersion: PROTOCOL_VERSION,
      commandId: "command-1",
      hostId: "host-1",
      sessionId: "session-1",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      command: { type: "session.interrupt", payload: {} },
    };
    const forwarded = nextFrame(agent);
    client.send(JSON.stringify(command));

    await expect(forwarded).resolves.toEqual(command);
  });

  it("rejects an expired command without forwarding it", async () => {
    const port = await startRelay();
    const client = await connect(port);
    await authenticateClient(client);
    const agent = await connect(port);
    await authenticateAgent(agent);

    const command: CommandEnvelope = {
      kind: "command",
      protocolVersion: PROTOCOL_VERSION,
      commandId: "expired-command",
      hostId: "host-1",
      sessionId: "session-1",
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 30_000).toISOString(),
      command: { type: "session.interrupt", payload: {} },
    };
    const result = nextFrame(client);
    client.send(JSON.stringify(command));

    await expect(result).resolves.toMatchObject({
      kind: "command.result",
      commandId: "expired-command",
      ok: false,
      error: "Command has expired",
    });

    const forwarded = await Promise.race([
      nextFrame(agent).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(forwarded).toBe(false);
  });
});

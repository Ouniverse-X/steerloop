import {
  PROTOCOL_VERSION,
  canonicalizeApprovalDecision,
  type CommandEnvelope,
  type EventEnvelope,
} from "@steerloop/protocol";
import { webcrypto } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer, type RelayServer } from "../src/server.js";

const TOKEN = "test-token-with-enough-entropy";
const openServers: RelayServer[] = [];
const openSockets: WebSocket[] = [];

interface TestDeviceKeyPair {
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

interface PairResult {
  body: Record<string, unknown>;
  privateKey: CryptoKey;
}

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate();
  for (const server of openServers.splice(0)) await server.stop();
});

async function startRelay(): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "steerloop-devices-"));
  const server = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    authTimeoutMs: 1_000,
    maxHistory: 50,
    maxPayloadBytes: 64 * 1_024,
    deviceRegistryPath: join(directory, "devices.json"),
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

function receivesFrameWithin(socket: WebSocket, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onMessage = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(true);
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      reject(error);
    };
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      resolve(false);
    }, timeoutMs);
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

async function createDeviceKeyPair(): Promise<TestDeviceKeyPair> {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pair.privateKey,
    publicKeyJwk: await webcrypto.subtle.exportKey("jwk", pair.publicKey),
  };
}

async function pairDevice(port: number, code: string): Promise<PairResult> {
  const keyPair = await createDeviceKeyPair();
  let lastStatus = 0;
  for (let index = 0; index < 20; index += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, devicePublicKey: keyPair.publicKeyJwk }),
    });
    lastStatus = response.status;
    const body = await response.json() as Record<string, unknown>;
    if (response.status === 200) return { body, privateKey: keyPair.privateKey };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Pairing did not become available; last status ${lastStatus}`);
}

async function signApprovalCommand(
  command: CommandEnvelope,
  deviceId: string,
  privateKey: CryptoKey,
): Promise<CommandEnvelope> {
  if (command.command.type !== "approval.resolve") return command;
  const signedAt = new Date().toISOString();
  const material = canonicalizeApprovalDecision({
    commandId: command.commandId,
    hostId: command.hostId,
    sessionId: command.sessionId,
    approvalId: command.command.payload.approvalId,
    requestDigest: command.command.payload.requestDigest,
    decision: command.command.payload.decision,
    deviceId,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
    signedAt,
  });
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(material),
  );
  return {
    ...command,
    command: {
      ...command.command,
      payload: {
        ...command.command.payload,
        authorization: {
          deviceId,
          algorithm: "ECDSA-P256-SHA256",
          signedAt,
          signature: bytesToBase64Url(signature),
        },
      },
    },
  };
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

  it("exchanges a host pairing code for a client token", async () => {
    const port = await startRelay();
    const agent = await connect(port);
    await authenticateAgent(agent);
    agent.send(JSON.stringify({
      kind: "pairing.offer",
      protocolVersion: PROTOCOL_VERSION,
      hostId: "host-1",
      code: "ABCD-1234",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    const { body } = await pairDevice(port, "abcd-1234");
    expect(body).toMatchObject({ ok: true, hostId: "host-1" });
    expect(String(body.token)).toMatch(/^slc_[a-f0-9]{64}$/);
    expect(body.device).toMatchObject({ hostId: "host-1" });

    const client = await connect(port);
    const frames = nextFrames(client, 2);
    client.send(
      JSON.stringify({
        kind: "auth",
        protocolVersion: PROTOCOL_VERSION,
        role: "client",
        token: body.token,
      }),
    );
    const [authResult, snapshot] = await frames;
    expect(authResult).toMatchObject({ kind: "auth.result", ok: true });
    expect(snapshot).toMatchObject({ kind: "snapshot", events: [] });

    const listResponse = await fetch(`http://127.0.0.1:${port}/devices`, {
      headers: { authorization: `Bearer ${String(body.token)}` },
    });
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json() as Record<string, unknown>;
    const devices = listBody.devices as Array<Record<string, unknown>>;
    expect(devices).toHaveLength(1);
    const pairedDevice = devices[0];
    if (pairedDevice === undefined) throw new Error("Expected a paired device");
    expect(pairedDevice).not.toHaveProperty("tokenHash");

    const revokeResponse = await fetch(`http://127.0.0.1:${port}/devices/${String(pairedDevice.id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${String(body.token)}` },
    });
    expect(revokeResponse.status).toBe(200);

    const replay = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ABCD-1234", devicePublicKey: (await createDeviceKeyPair()).publicKeyJwk }),
    });
    expect(replay.status).toBe(401);

    const revokedClient = await connect(port);
    const revokedAuth = nextFrame(revokedClient);
    revokedClient.send(
      JSON.stringify({
        kind: "auth",
        protocolVersion: PROTOCOL_VERSION,
        role: "client",
        token: body.token,
      }),
    );
    await expect(revokedAuth).resolves.toMatchObject({
      kind: "auth.result",
      ok: false,
    });
  });

  it("requires paired approval decisions to be signed by the authenticated device", async () => {
    const port = await startRelay();
    const agent = await connect(port);
    await authenticateAgent(agent);
    agent.send(JSON.stringify({
      kind: "pairing.offer",
      protocolVersion: PROTOCOL_VERSION,
      hostId: "host-1",
      code: "SIGN-0001",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    const { body, privateKey } = await pairDevice(port, "SIGN-0001");
    const token = String(body.token);
    const device = body.device as Record<string, unknown>;
    const deviceId = String(device.id);

    const client = await connect(port);
    const frames = nextFrames(client, 2);
    client.send(
      JSON.stringify({
        kind: "auth",
        protocolVersion: PROTOCOL_VERSION,
        role: "client",
        token,
      }),
    );
    const [authResult] = await frames;
    expect(authResult).toMatchObject({ kind: "auth.result", ok: true });

    const command: CommandEnvelope = {
      kind: "command",
      protocolVersion: PROTOCOL_VERSION,
      commandId: "approval-command-1",
      hostId: "host-1",
      sessionId: "session-1",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      command: {
        type: "approval.resolve",
        payload: {
          approvalId: "approval-1",
          requestDigest: "a".repeat(64),
          decision: "approve_once",
        },
      },
    };

    const unsignedResult = nextFrame(client);
    client.send(JSON.stringify(command));
    await expect(unsignedResult).resolves.toMatchObject({
      kind: "command.result",
      commandId: "approval-command-1",
      ok: false,
      error: "Missing device approval signature",
    });
    await expect(receivesFrameWithin(agent, 50)).resolves.toBe(false);

    const signedCommand = await signApprovalCommand(
      { ...command, commandId: "approval-command-2" },
      deviceId,
      privateKey,
    );
    const forwarded = nextFrame(agent);
    client.send(JSON.stringify(signedCommand));
    await expect(forwarded).resolves.toEqual(signedCommand);
  });

  it("keeps paired device tokens across relay restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steerloop-device-restart-"));
    const config = {
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      authTimeoutMs: 1_000,
      maxHistory: 50,
      maxPayloadBytes: 64 * 1_024,
      deviceRegistryPath: join(directory, "devices.json"),
    };
    const firstRelay = createRelayServer(config);
    openServers.push(firstRelay);
    const firstPort = await firstRelay.start();
    const agent = await connect(firstPort);
    await authenticateAgent(agent);
    agent.send(JSON.stringify({
      kind: "pairing.offer",
      protocolVersion: PROTOCOL_VERSION,
      hostId: "host-1",
      code: "KEEP-0001",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const { body: pairBody } = await pairDevice(firstPort, "KEEP-0001");
    const token = String(pairBody.token);

    agent.terminate();
    await firstRelay.stop();
    openServers.splice(openServers.indexOf(firstRelay), 1);

    const secondRelay = createRelayServer(config);
    openServers.push(secondRelay);
    const secondPort = await secondRelay.start();
    const client = await connect(secondPort);
    const frames = nextFrames(client, 2);
    client.send(
      JSON.stringify({
        kind: "auth",
        protocolVersion: PROTOCOL_VERSION,
        role: "client",
        token,
      }),
    );
    const [authResult, snapshot] = await frames;
    expect(authResult).toMatchObject({ kind: "auth.result", ok: true });
    expect(snapshot).toMatchObject({ kind: "snapshot" });
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

    await expect(receivesFrameWithin(agent, 50)).resolves.toBe(false);
  });

  it("restores the event snapshot after a relay restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steerloop-relay-restart-"));
    const journalPath = join(directory, "events.jsonl");
    const config = {
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      authTimeoutMs: 1_000,
      maxHistory: 50,
      maxPayloadBytes: 64 * 1_024,
      journalPath,
      journalSync: true,
      deviceRegistryPath: join(directory, "devices.json"),
    };
    const firstRelay = createRelayServer(config);
    openServers.push(firstRelay);
    const firstPort = await firstRelay.start();
    const client = await connect(firstPort);
    await authenticateClient(client);
    const agent = await connect(firstPort);
    await authenticateAgent(agent);
    const persistedEvent: EventEnvelope = {
      kind: "event",
      protocolVersion: PROTOCOL_VERSION,
      eventId: "persisted-event",
      sequence: 1,
      hostId: "host-1",
      emittedAt: new Date().toISOString(),
      event: {
        type: "host.connected",
        payload: {
          name: "Persistent host",
          platform: "linux",
          agentVersion: "0.1.0",
          capabilities: [],
        },
      },
    };
    const forwarded = nextFrame(client);
    agent.send(JSON.stringify(persistedEvent));
    await expect(forwarded).resolves.toEqual(persistedEvent);

    client.terminate();
    agent.terminate();
    await firstRelay.stop();
    openServers.splice(openServers.indexOf(firstRelay), 1);

    const secondRelay = createRelayServer(config);
    openServers.push(secondRelay);
    const secondPort = await secondRelay.start();
    const restoredClient = await connect(secondPort);
    const frames = nextFrames(restoredClient, 2);
    restoredClient.send(
      JSON.stringify({
        kind: "auth",
        protocolVersion: PROTOCOL_VERSION,
        role: "client",
        token: TOKEN,
      }),
    );
    const [, snapshot] = await frames;
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      events: [{ eventId: "persisted-event" }],
    });
  });
});

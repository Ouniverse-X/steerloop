import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  PROTOCOL_VERSION,
  agentToRelayFrameSchema,
  authFrameSchema,
  canonicalizeApprovalDecision,
  clientToRelayFrameSchema,
  commandEnvelopeSchema,
  type AuthFrame,
  type CommandResult,
  type EventEnvelope,
  type PairingOfferFrame,
} from "@steerloop/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { RelayConfig } from "./config.js";
import { DeviceRegistry, isP256PublicKey } from "./device-registry.js";
import { EventJournal } from "./event-journal.js";

interface UnauthenticatedPeer {
  authenticated: false;
}

interface AgentPeer {
  authenticated: true;
  role: "agent";
  hostId: string;
}

interface ClientPeer {
  authenticated: true;
  role: "client";
  deviceId?: string;
}

type Peer = UnauthenticatedPeer | AgentPeer | ClientPeer;

export interface RelayServer {
  start(): Promise<number>;
  stop(): Promise<void>;
}

function tokenMatches(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function send(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8_192) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function commandError(
  commandId: string,
  hostId: string,
  error: string,
): CommandResult {
  return {
    kind: "command.result",
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    hostId,
    ok: false,
    error,
  };
}

export function createRelayServer(config: RelayConfig): RelayServer {
  const pairingOffers = new Map<string, PairingOfferFrame>();
  let deviceRegistry: DeviceRegistry | undefined;

  function authenticateHttp(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Bearer ")) return false;
    const token = header.slice("Bearer ".length);
    return tokenMatches(config.token, token) || deviceRegistry?.verify(token) !== undefined;
  }

  function clientDevice(received: string): { ok: true; deviceId?: string } | { ok: false } {
    if (tokenMatches(config.token, received)) return { ok: true };
    const device = deviceRegistry?.verify(received);
    return device === undefined ? { ok: false } : { ok: true, deviceId: device.id };
  }

  function registerPairingOffer(offer: PairingOfferFrame): void {
    for (const [code, existing] of pairingOffers) {
      if (
        existing.hostId === offer.hostId ||
        Date.parse(existing.expiresAt) <= Date.now()
      ) {
        pairingOffers.delete(code);
      }
    }
    pairingOffers.set(offer.code, offer);
    console.log(`[relay] registered pairing code for host ${offer.hostId}`);
  }

  const httpServer: Server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          agents: agents.size,
          clients: clients.size,
          events: history.length,
          pairings: pairingOffers.size,
          devices: deviceRegistry?.list().filter((device) => device.revokedAt === undefined).length ?? 0,
        }),
      );
      return;
    }

    if (request.method === "POST" && request.url === "/pair") {
      void readJsonBody(request).then(async (value) => {
        const record = typeof value === "object" && value !== null
          ? value as Record<string, unknown>
          : {};
        const code = typeof record.code === "string"
          ? record.code.trim().toUpperCase()
          : "";
        const offer = pairingOffers.get(code);
        if (offer === undefined || Date.parse(offer.expiresAt) <= Date.now()) {
          if (offer !== undefined) pairingOffers.delete(code);
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: "invalid_pairing_code" }));
          return;
        }
        if (!isP256PublicKey(record.devicePublicKey)) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: "invalid_device_public_key" }));
          return;
        }
        pairingOffers.delete(code);
        const issued = await deviceRegistry?.issue(
          offer.hostId,
          typeof record.deviceName === "string" && record.deviceName.trim().length > 0
            ? record.deviceName.trim().slice(0, 128)
            : "Browser device",
          record.devicePublicKey,
        );
        if (issued === undefined) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: "device_registry_unavailable" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          token: issued.token,
          device: issued.device,
          hostId: offer.hostId,
          expiresAt: offer.expiresAt,
        }));
      }).catch((error) => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "invalid_pairing_request",
        }));
      });
      return;
    }

    if (request.method === "GET" && request.url === "/devices") {
      if (!authenticateHttp(request)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        devices: deviceRegistry?.list() ?? [],
      }));
      return;
    }

    const deviceDeleteMatch = request.url?.match(/^\/devices\/([^/]+)$/);
    if (request.method === "DELETE" && deviceDeleteMatch !== undefined && deviceDeleteMatch !== null) {
      const deviceId = deviceDeleteMatch[1];
      if (deviceId === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "device_not_found" }));
        return;
      }
      if (!authenticateHttp(request)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      const device = await deviceRegistry?.revoke(decodeURIComponent(deviceId));
      if (device === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "device_not_found" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, device }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  const webSocketServer = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: config.maxPayloadBytes,
  });
  const peers = new WeakMap<WebSocket, Peer>();
  const agents = new Map<string, WebSocket>();
  const clients = new Set<WebSocket>();
  let history: EventEnvelope[] = [];
  let journal: EventJournal | undefined;
  let agentFrameQueue: Promise<void> = Promise.resolve();

  function broadcastToClients(frame: unknown): void {
    for (const client of clients) send(client, frame);
  }

  function reject(socket: WebSocket, error: string): void {
    send(socket, {
      kind: "auth.result",
      protocolVersion: PROTOCOL_VERSION,
      ok: false,
      error,
    });
    socket.close(1008, "authentication failed");
  }

  function authenticate(socket: WebSocket, auth: AuthFrame): void {
    if (auth.role === "agent" && !tokenMatches(config.token, auth.token)) {
      reject(socket, "Invalid credentials");
      return;
    }
    const clientAuth = auth.role === "client" ? clientDevice(auth.token) : undefined;
    if (auth.role === "client" && clientAuth?.ok !== true) {
      reject(socket, "Invalid credentials");
      return;
    }

    if (auth.role === "agent") {
      const existing = agents.get(auth.hostId);
      if (existing !== undefined && existing !== socket) {
        existing.close(1012, "replaced by a newer host connection");
      }
      peers.set(socket, {
        authenticated: true,
        role: "agent",
        hostId: auth.hostId,
      });
      agents.set(auth.hostId, socket);
    } else {
      const deviceId = clientAuth?.ok === true ? clientAuth.deviceId : undefined;
      peers.set(socket, {
        authenticated: true,
        role: "client",
        ...(deviceId === undefined ? {} : { deviceId }),
      });
      clients.add(socket);
    }

    send(socket, {
      kind: "auth.result",
      protocolVersion: PROTOCOL_VERSION,
      ok: true,
    });

    if (auth.role === "client") {
      send(socket, {
        kind: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        events: history,
      });
    }
  }

  async function handleAgentFrame(
    socket: WebSocket,
    peer: AgentPeer,
    value: unknown,
  ): Promise<void> {
    const parsed = agentToRelayFrameSchema.safeParse(value);
    if (!parsed.success || parsed.data.kind === "auth") {
      socket.close(1008, "invalid agent frame");
      return;
    }

    if (parsed.data.hostId !== peer.hostId) {
      socket.close(1008, "host identity mismatch");
      return;
    }

    if (parsed.data.kind === "pairing.offer") {
      registerPairingOffer(parsed.data);
      return;
    }

    if (parsed.data.kind === "event") {
      history = journal === undefined
        ? [...history, parsed.data].slice(-config.maxHistory)
        : await journal.append(parsed.data);
    }
    broadcastToClients(parsed.data);
  }

  async function verifyApprovalAuthorization(
    peer: ClientPeer,
    command: ReturnType<typeof commandEnvelopeSchema.parse>,
  ): Promise<string | undefined> {
    if (command.command.type !== "approval.resolve") return undefined;
    if (peer.deviceId === undefined) return undefined;
    const authorization = command.command.payload.authorization;
    if (authorization === undefined) return "Missing device approval signature";
    if (authorization.deviceId !== peer.deviceId) return "Approval signature device mismatch";
    if (authorization.algorithm !== "ECDSA-P256-SHA256") return "Unsupported approval signature";
    const valid = await deviceRegistry?.verifySignature(
      peer.deviceId,
      canonicalizeApprovalDecision({
        commandId: command.commandId,
        hostId: command.hostId,
        sessionId: command.sessionId,
        approvalId: command.command.payload.approvalId,
        requestDigest: command.command.payload.requestDigest,
        decision: command.command.payload.decision,
        deviceId: authorization.deviceId,
        issuedAt: command.issuedAt,
        expiresAt: command.expiresAt,
        signedAt: authorization.signedAt,
      }),
      authorization.signature,
    );
    return valid === true ? undefined : "Invalid approval signature";
  }

  async function handleClientFrame(socket: WebSocket, peer: ClientPeer, value: unknown): Promise<void> {
    const parsed = clientToRelayFrameSchema.safeParse(value);
    if (!parsed.success || parsed.data.kind === "auth") {
      socket.close(1008, "invalid client frame");
      return;
    }

    const command = commandEnvelopeSchema.parse(parsed.data);
    const authorizationError = await verifyApprovalAuthorization(peer, command);
    if (authorizationError !== undefined) {
      send(
        socket,
        commandError(command.commandId, command.hostId, authorizationError),
      );
      return;
    }
    if (Date.parse(command.expiresAt) <= Date.now()) {
      send(
        socket,
        commandError(command.commandId, command.hostId, "Command has expired"),
      );
      return;
    }

    const agent = agents.get(command.hostId);
    if (agent === undefined || agent.readyState !== WebSocket.OPEN) {
      send(
        socket,
        commandError(command.commandId, command.hostId, "Host is offline"),
      );
      return;
    }

    send(agent, command);
  }

  webSocketServer.on("connection", (socket) => {
    peers.set(socket, { authenticated: false });
    const authTimer = setTimeout(() => {
      if (peers.get(socket)?.authenticated !== true) {
        socket.close(1008, "authentication timeout");
      }
    }, config.authTimeoutMs);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "binary frames are unsupported");
        return;
      }

      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        socket.close(1007, "invalid JSON");
        return;
      }

      const peer = peers.get(socket) ?? { authenticated: false };
      if (!peer.authenticated) {
        const parsed = authFrameSchema.safeParse(value);
        if (!parsed.success) {
          reject(socket, "Authentication must be the first frame");
          return;
        }
        clearTimeout(authTimer);
        authenticate(socket, parsed.data);
        return;
      }

      if (peer.role === "agent") {
        agentFrameQueue = agentFrameQueue
          .then(() => handleAgentFrame(socket, peer, value))
          .catch((error) => {
            console.error("[relay] failed to persist agent frame", error);
            socket.close(1011, "relay persistence failure");
          });
      } else {
        agentFrameQueue = agentFrameQueue
          .then(() => handleClientFrame(socket, peer, value))
          .catch((error) => {
            console.error("[relay] failed to handle client frame", error);
            socket.close(1011, "relay command failure");
          });
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      const peer = peers.get(socket);
      if (peer?.authenticated !== true) return;
      if (peer.role === "agent") {
        if (agents.get(peer.hostId) === socket) agents.delete(peer.hostId);
      } else {
        clients.delete(socket);
      }
    });
  });

  return {
    async start() {
      if (config.journalPath !== undefined) {
        journal = await EventJournal.open({
          path: config.journalPath,
          maxEvents: config.maxHistory,
          syncWrites: config.journalSync ?? true,
        });
        history = journal.snapshot();
      }
      if (config.deviceRegistryPath !== undefined) {
        deviceRegistry = await DeviceRegistry.open({ path: config.deviceRegistryPath });
      }
      await new Promise<void>((resolve, rejectPromise) => {
        httpServer.once("error", rejectPromise);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off("error", rejectPromise);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("Relay did not bind a TCP port");
      }
      return address.port;
    },
    async stop() {
      for (const socket of webSocketServer.clients) {
        socket.close(1001, "relay shutting down");
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      httpServer.closeIdleConnections();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, rejectPromise) => {
        httpServer.close((error) => {
          if (error === undefined) resolve();
          else rejectPromise(error);
        });
      });
      await agentFrameQueue;
      await journal?.close();
      journal = undefined;
      deviceRegistry = undefined;
    },
  };
}

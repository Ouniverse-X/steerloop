import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  PROTOCOL_VERSION,
  agentToRelayFrameSchema,
  authFrameSchema,
  clientToRelayFrameSchema,
  commandEnvelopeSchema,
  type AuthFrame,
  type CommandResult,
  type EventEnvelope,
} from "@steerloop/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { RelayConfig } from "./config.js";
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
  const httpServer: Server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          agents: agents.size,
          clients: clients.size,
          events: history.length,
        }),
      );
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
    if (!tokenMatches(config.token, auth.token)) {
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
      peers.set(socket, { authenticated: true, role: "client" });
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

    if (parsed.data.kind === "event") {
      history = journal === undefined
        ? [...history, parsed.data].slice(-config.maxHistory)
        : await journal.append(parsed.data);
    }
    broadcastToClients(parsed.data);
  }

  function handleClientFrame(socket: WebSocket, value: unknown): void {
    const parsed = clientToRelayFrameSchema.safeParse(value);
    if (!parsed.success || parsed.data.kind === "auth") {
      socket.close(1008, "invalid client frame");
      return;
    }

    const command = commandEnvelopeSchema.parse(parsed.data);
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
        handleClientFrame(socket, value);
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
      await new Promise<void>((resolve, rejectPromise) => {
        httpServer.close((error) => {
          if (error === undefined) resolve();
          else rejectPromise(error);
        });
      });
      await agentFrameQueue;
      await journal?.close();
      journal = undefined;
    },
  };
}

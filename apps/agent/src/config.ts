import { hostname, platform } from "node:os";

export type AdapterName = "demo" | "codex";

export interface AgentConfig {
  relayUrl: string;
  token: string;
  hostId: string;
  hostName: string;
  platform: string;
  adapter: AdapterName;
  heartbeatMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
}

const DEVELOPMENT_TOKEN = "steerloop-local-dev";

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function adapterName(value: string | undefined): AdapterName {
  const candidate = value ?? "demo";
  if (candidate !== "demo" && candidate !== "codex") {
    throw new Error("STEERLOOP_ADAPTER must be demo or codex");
  }
  return candidate;
}

export function loadAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const production = environment.NODE_ENV === "production";
  const token = environment.STEERLOOP_TOKEN;
  if (production && token === undefined) {
    throw new Error("STEERLOOP_TOKEN is required in production");
  }

  return {
    relayUrl: environment.STEERLOOP_RELAY_URL ?? "ws://127.0.0.1:8787/ws",
    token: token ?? DEVELOPMENT_TOKEN,
    hostId: environment.STEERLOOP_HOST_ID ?? hostname(),
    hostName: environment.STEERLOOP_HOST_NAME ?? hostname(),
    platform: platform(),
    adapter: adapterName(environment.STEERLOOP_ADAPTER),
    heartbeatMs: parsePositiveInteger(
      environment.STEERLOOP_HEARTBEAT_MS,
      15_000,
      "STEERLOOP_HEARTBEAT_MS",
    ),
    reconnectMinMs: parsePositiveInteger(
      environment.STEERLOOP_RECONNECT_MIN_MS,
      500,
      "STEERLOOP_RECONNECT_MIN_MS",
    ),
    reconnectMaxMs: parsePositiveInteger(
      environment.STEERLOOP_RECONNECT_MAX_MS,
      30_000,
      "STEERLOOP_RECONNECT_MAX_MS",
    ),
  };
}

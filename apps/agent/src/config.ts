import { readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { randomBytes } from "node:crypto";

export type AdapterName = "demo" | "codex";

export interface AgentConfig {
  relayUrl: string;
  token: string;
  hostId: string;
  hostName: string;
  platform: string;
  adapter: AdapterName;
  codexCommand: string;
  heartbeatMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  pairingCode: string;
  pairingExpiresAt: string;
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

function pairingCode(value: string | undefined): string {
  if (value !== undefined && value.trim().length > 0) {
    return value.trim().toUpperCase();
  }
  return randomBytes(4).toString("hex").toUpperCase().replace(/^(.{4})(.{4})$/, "$1-$2");
}

export function loadAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const production = environment.NODE_ENV === "production";
  if (
    environment.STEERLOOP_TOKEN !== undefined &&
    environment.STEERLOOP_TOKEN_FILE !== undefined
  ) {
    throw new Error("Set only one of STEERLOOP_TOKEN and STEERLOOP_TOKEN_FILE");
  }
  const token = environment.STEERLOOP_TOKEN_FILE === undefined
    ? environment.STEERLOOP_TOKEN
    : readFileSync(environment.STEERLOOP_TOKEN_FILE, "utf8").trim();
  if (production && token === undefined) {
    throw new Error("STEERLOOP_TOKEN or STEERLOOP_TOKEN_FILE is required in production");
  }
  if (token !== undefined && token.length === 0) {
    throw new Error("Steerloop token must not be empty");
  }
  if (production && (token?.length ?? 0) < 32) {
    throw new Error("Production Steerloop tokens must contain at least 32 characters");
  }
  const pairingTtlMs = parsePositiveInteger(
    environment.STEERLOOP_PAIRING_TTL_MS,
    10 * 60_000,
    "STEERLOOP_PAIRING_TTL_MS",
  );

  return {
    relayUrl: environment.STEERLOOP_RELAY_URL ?? "ws://127.0.0.1:8787/ws",
    token: token ?? DEVELOPMENT_TOKEN,
    hostId: environment.STEERLOOP_HOST_ID ?? hostname(),
    hostName: environment.STEERLOOP_HOST_NAME ?? hostname(),
    platform: platform(),
    adapter: adapterName(environment.STEERLOOP_ADAPTER),
    codexCommand: environment.STEERLOOP_CODEX_COMMAND ?? "codex",
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
    pairingCode: pairingCode(environment.STEERLOOP_PAIRING_CODE),
    pairingExpiresAt: new Date(Date.now() + pairingTtlMs).toISOString(),
  };
}

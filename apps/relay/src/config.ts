import { readFileSync } from "node:fs";

export interface RelayConfig {
  host: string;
  port: number;
  token: string;
  authTimeoutMs: number;
  maxHistory: number;
  maxPayloadBytes: number;
  journalPath?: string;
  journalSync?: boolean;
  deviceRegistryPath?: string;
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

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

export function loadRelayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RelayConfig {
  const production = environment.NODE_ENV === "production";
  if (
    environment.STEERLOOP_TOKEN !== undefined &&
    environment.STEERLOOP_TOKEN_FILE !== undefined
  ) {
    throw new Error("Set only one of STEERLOOP_TOKEN and STEERLOOP_TOKEN_FILE");
  }
  const configuredToken = environment.STEERLOOP_TOKEN_FILE === undefined
    ? environment.STEERLOOP_TOKEN
    : readFileSync(environment.STEERLOOP_TOKEN_FILE, "utf8").trim();
  if (production && configuredToken === undefined) {
    throw new Error("STEERLOOP_TOKEN or STEERLOOP_TOKEN_FILE is required in production");
  }
  if (configuredToken !== undefined && configuredToken.length === 0) {
    throw new Error("Steerloop token must not be empty");
  }
  if (production && (configuredToken?.length ?? 0) < 32) {
    throw new Error("Production Steerloop tokens must contain at least 32 characters");
  }

  const journalPath = environment.STEERLOOP_JOURNAL_PATH ??
    "steerloop-data/relay-events.jsonl";
  const deviceRegistryPath = environment.STEERLOOP_DEVICE_REGISTRY_PATH ??
    "steerloop-data/relay-devices.json";
  return {
    host: environment.STEERLOOP_RELAY_HOST ?? "127.0.0.1",
    port: parsePositiveInteger(
      environment.STEERLOOP_RELAY_PORT,
      8787,
      "STEERLOOP_RELAY_PORT",
    ),
    token: configuredToken ?? DEVELOPMENT_TOKEN,
    authTimeoutMs: parsePositiveInteger(
      environment.STEERLOOP_AUTH_TIMEOUT_MS,
      5_000,
      "STEERLOOP_AUTH_TIMEOUT_MS",
    ),
    maxHistory: parsePositiveInteger(
      environment.STEERLOOP_MAX_HISTORY,
      1_000,
      "STEERLOOP_MAX_HISTORY",
    ),
    maxPayloadBytes: parsePositiveInteger(
      environment.STEERLOOP_MAX_PAYLOAD_BYTES,
      512 * 1_024,
      "STEERLOOP_MAX_PAYLOAD_BYTES",
    ),
    ...(journalPath === "off" ? {} : { journalPath }),
    journalSync: parseBoolean(
      environment.STEERLOOP_JOURNAL_SYNC,
      true,
      "STEERLOOP_JOURNAL_SYNC",
    ),
    ...(deviceRegistryPath === "off" ? {} : { deviceRegistryPath }),
  };
}

export function usesDevelopmentToken(config: RelayConfig): boolean {
  return config.token === DEVELOPMENT_TOKEN;
}

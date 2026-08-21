export interface RelayConfig {
  host: string;
  port: number;
  token: string;
  authTimeoutMs: number;
  maxHistory: number;
  maxPayloadBytes: number;
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

export function loadRelayConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RelayConfig {
  const production = environment.NODE_ENV === "production";
  const configuredToken = environment.STEERLOOP_TOKEN;
  if (production && configuredToken === undefined) {
    throw new Error("STEERLOOP_TOKEN is required in production");
  }

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
  };
}

export function usesDevelopmentToken(config: RelayConfig): boolean {
  return config.token === DEVELOPMENT_TOKEN;
}

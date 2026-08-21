import { loadRelayConfig, usesDevelopmentToken } from "./config.js";
import { createRelayServer } from "./server.js";

const config = loadRelayConfig();
const server = createRelayServer(config);
const port = await server.start();

if (usesDevelopmentToken(config)) {
  console.warn(
    "[relay] using the local development token; do not expose this relay publicly",
  );
}
console.log(`[relay] listening on ws://${config.host}:${port}/ws`);

async function shutdown(): Promise<void> {
  console.log("[relay] shutting down");
  await server.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

export { createRelayServer } from "./server.js";

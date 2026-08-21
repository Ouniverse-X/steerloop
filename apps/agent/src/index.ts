import { AgentController } from "./controller.js";
import { CodexAdapter } from "./codex-adapter.js";
import { loadAgentConfig } from "./config.js";
import { DemoAdapter } from "./demo-adapter.js";

const config = loadAgentConfig();
const adapter =
  config.adapter === "codex" ? new CodexAdapter(config.codexCommand) : new DemoAdapter();
const controller = new AgentController(config, adapter);

await controller.start();
console.log(
  `[agent] ${config.hostId} started with ${adapter.name} adapter; relay ${config.relayUrl}`,
);
console.log(
  `[agent] pairing code ${config.pairingCode} expires at ${config.pairingExpiresAt}`,
);

async function shutdown(): Promise<void> {
  console.log("[agent] shutting down");
  await controller.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

export { AgentController } from "./controller.js";
export { CodexAdapter } from "./codex-adapter.js";
export { DemoAdapter } from "./demo-adapter.js";

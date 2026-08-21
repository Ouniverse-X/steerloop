import { probeCodexCompatibility } from "../../apps/agent/src/compatibility.js";

const report = await probeCodexCompatibility(
  process.env.STEERLOOP_CODEX_COMMAND ?? "codex",
);

console.log(JSON.stringify(report, null, 2));
if (!report.compatible) process.exitCode = 1;

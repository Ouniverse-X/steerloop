import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodexAppServerClient } from "./codex-app-server.js";

const execFileAsync = promisify(execFile);
export const TESTED_CODEX_CLI_VERSION = "0.147.0";

export interface CodexCompatibilityReport {
  compatible: boolean;
  cliVersion: string;
  testedVersion: string;
  initialized: boolean;
  threadList: boolean;
  modelList: boolean;
  threadCountSampled: number;
  modelCountSampled: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function versionTuple(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: string, minimum: string): boolean {
  const actual = versionTuple(version);
  const required = versionTuple(minimum);
  if (actual === undefined || required === undefined) return false;
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

export async function probeCodexCompatibility(
  command = "codex",
): Promise<CodexCompatibilityReport> {
  const versionResult = await execFileAsync(command, ["--version"], {
    timeout: 10_000,
  });
  const cliVersion = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(versionResult.stdout)?.[1];
  if (cliVersion === undefined) {
    throw new Error(`Could not parse Codex CLI version from: ${versionResult.stdout.trim()}`);
  }

  const client = new CodexAppServerClient({
    command,
    requestTimeoutMs: 15_000,
    onStderr: (line) => {
      if (!line.includes("PATH aliases")) process.stderr.write(`[codex] ${line}\n`);
    },
  });

  try {
    await client.start();
    const threads = asRecord(
      await client.request("thread/list", {
        limit: 1,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        useStateDbOnly: true,
      }),
    );
    const models = asRecord(
      await client.request("model/list", { limit: 1, includeHidden: false }),
    );
    const threadData = Array.isArray(threads.data) ? threads.data : undefined;
    const modelData = Array.isArray(models.data) ? models.data : undefined;
    const initialized = client.serverInfo !== undefined;
    const threadList = threadData !== undefined;
    const modelList = modelData !== undefined;

    return {
      compatible:
        atLeast(cliVersion, TESTED_CODEX_CLI_VERSION) &&
        initialized &&
        threadList &&
        modelList,
      cliVersion,
      testedVersion: TESTED_CODEX_CLI_VERSION,
      initialized,
      threadList,
      modelList,
      threadCountSampled: threadData?.length ?? 0,
      modelCountSampled: modelData?.length ?? 0,
    };
  } finally {
    await client.stop();
  }
}

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";

describe("agent production configuration", () => {
  it("loads the shared Relay token and Codex executable path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steerloop-agent-token-"));
    const tokenPath = join(directory, "relay-token");
    await writeFile(tokenPath, "0123456789abcdef0123456789abcdef\n", { mode: 0o600 });

    const config = loadAgentConfig({
      NODE_ENV: "production",
      STEERLOOP_TOKEN_FILE: tokenPath,
      STEERLOOP_CODEX_COMMAND: "/opt/codex/bin/codex",
      STEERLOOP_PAIRING_CODE: "ABCD-1234",
      STEERLOOP_PAIRING_TTL_MS: "60000",
    });

    expect(config.token).toBe("0123456789abcdef0123456789abcdef");
    expect(config.codexCommand).toBe("/opt/codex/bin/codex");
    expect(config.pairingCode).toBe("ABCD-1234");
  });

  it("rejects ambiguous token configuration", () => {
    expect(() =>
      loadAgentConfig({
        STEERLOOP_TOKEN: "one",
        STEERLOOP_TOKEN_FILE: "/tmp/another",
      }),
    ).toThrow("Set only one");
  });
});

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRelayConfig } from "../src/config.js";

describe("relay production configuration", () => {
  it("loads a high-entropy token from a secret file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steerloop-token-"));
    const tokenPath = join(directory, "relay-token");
    await writeFile(tokenPath, "0123456789abcdef0123456789abcdef\n", { mode: 0o600 });

    const config = loadRelayConfig({
      NODE_ENV: "production",
      STEERLOOP_TOKEN_FILE: tokenPath,
      STEERLOOP_JOURNAL_PATH: "/data/events.jsonl",
    });

    expect(config.token).toBe("0123456789abcdef0123456789abcdef");
    expect(config.journalPath).toBe("/data/events.jsonl");
  });

  it("rejects short production tokens", () => {
    expect(() =>
      loadRelayConfig({ NODE_ENV: "production", STEERLOOP_TOKEN: "too-short" }),
    ).toThrow("at least 32 characters");
  });

  it("can explicitly disable persistence for disposable tests", () => {
    const config = loadRelayConfig({ STEERLOOP_JOURNAL_PATH: "off" });
    expect(config.journalPath).toBeUndefined();
  });
});

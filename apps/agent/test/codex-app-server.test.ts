import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../src/codex-app-server.js";
import { summarizeRequestedPermissions } from "../src/codex-adapter.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);

describe("Codex App Server client", () => {
  it("renders current filesystem and network permission requests", () => {
    expect(
      summarizeRequestedPermissions({
        network: { enabled: true },
        fileSystem: {
          read: ["/workspace/reference"],
          write: null,
          entries: [
            { access: "write", path: { type: "path", path: "/workspace/output" } },
          ],
        },
      }),
    ).toEqual([
      "Enable network access",
      "read: /workspace/reference",
      "write: /workspace/output",
    ]);
  });

  it("performs initialize/initialized before read-only requests", async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 1_000,
    });

    try {
      await client.start();
      await expect(client.request("thread/list", { limit: 1 })).resolves.toEqual({
        data: [],
        nextCursor: null,
      });
      expect(client.serverInfo).toMatchObject({ platformFamily: "unix" });
    } finally {
      await client.stop();
    }
  });

  it("bounds requests with a timeout", async () => {
    const client = new CodexAppServerClient({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 250,
    });

    try {
      await client.start();
      await expect(client.request("never/respond", {})).rejects.toThrow(
        "Codex request timed out: never/respond",
      );
    } finally {
      await client.stop();
    }
  });
});

import { describe, expect, it } from "vitest";
import { buildCommand, defaultRelayUrl } from "../src/connection.js";

describe("web command creation", () => {
  it("creates a short-lived, allowlisted command", () => {
    const command = buildCommand(
      "host-1",
      "session-1",
      { type: "session.interrupt", payload: {} },
      Date.parse("2026-08-21T00:00:00.000Z"),
      "command-1",
    );

    expect(command).toMatchObject({
      commandId: "command-1",
      hostId: "host-1",
      sessionId: "session-1",
      issuedAt: "2026-08-21T00:00:00.000Z",
      expiresAt: "2026-08-21T00:00:30.000Z",
      command: { type: "session.interrupt" },
    });
  });

  it("uses secure WebSockets behind HTTPS", () => {
    expect(defaultRelayUrl({ hostname: "steerloop.example", protocol: "https:" })).toBe(
      "wss://steerloop.example:8787/ws",
    );
  });
});

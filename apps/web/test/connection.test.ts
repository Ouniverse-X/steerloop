import { describe, expect, it } from "vitest";
import { buildCommand, defaultRelayUrl, pairingUrl } from "../src/connection.js";

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
    expect(defaultRelayUrl({ host: "steerloop.example", protocol: "https:" })).toBe(
      "wss://steerloop.example/ws",
    );
  });

  it("uses the page origin during local development", () => {
    expect(defaultRelayUrl({ host: "127.0.0.1:5173", protocol: "http:" })).toBe(
      "ws://127.0.0.1:5173/ws",
    );
  });

  it("derives the pairing endpoint from the relay URL", () => {
    expect(pairingUrl("wss://steerloop.example/ws")).toBe("https://steerloop.example/pair");
    expect(pairingUrl("ws://127.0.0.1:5173/ws")).toBe("http://127.0.0.1:5173/pair");
  });
});

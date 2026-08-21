import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type NormalizedEvent,
} from "@steerloop/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DemoAdapter } from "../src/demo-adapter.js";

const adapters: DemoAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
});

function command(
  sessionId: string,
  normalized: CommandEnvelope["command"],
): CommandEnvelope {
  return {
    kind: "command",
    protocolVersion: PROTOCOL_VERSION,
    commandId: randomUUID(),
    hostId: "host-1",
    sessionId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    command: normalized,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for demo event");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("DemoAdapter", () => {
  it("completes a run after an exact one-time approval", async () => {
    const adapter = new DemoAdapter({ approvalDelayMs: 1, completionDelayMs: 1 });
    adapters.push(adapter);
    const events: NormalizedEvent[] = [];
    await adapter.start({
      hostId: "host-1",
      emit: (_sessionId, event) => events.push(event),
    });
    await waitFor(() => events.some((event) => event.type === "approval.requested"));
    const request = events.find((event) => event.type === "approval.requested");
    if (request?.type !== "approval.requested") throw new Error("Missing request");

    await adapter.handleCommand(
      command("demo-host-1", {
        type: "approval.resolve",
        payload: {
          approvalId: request.payload.approvalId,
          requestDigest: request.payload.requestDigest,
          decision: "approve_once",
        },
      }),
    );
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "session.status.changed" &&
          event.payload.status === "completed",
      ),
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: "approval.resolved" }),
    );
  });

  it("rejects a substituted approval digest", async () => {
    const adapter = new DemoAdapter({ approvalDelayMs: 1 });
    adapters.push(adapter);
    const events: NormalizedEvent[] = [];
    await adapter.start({
      hostId: "host-1",
      emit: (_sessionId, event) => events.push(event),
    });
    await waitFor(() => events.some((event) => event.type === "approval.requested"));
    const request = events.find((event) => event.type === "approval.requested");
    if (request?.type !== "approval.requested") throw new Error("Missing request");

    await expect(
      adapter.handleCommand(
        command("demo-host-1", {
          type: "approval.resolve",
          payload: {
            approvalId: request.payload.approvalId,
            requestDigest: "0".repeat(64),
            decision: "approve_once",
          },
        }),
      ),
    ).rejects.toThrow("digest mismatch");
  });
});

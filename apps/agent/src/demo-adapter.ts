import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizeApproval,
  type CommandEnvelope,
  type NormalizedEvent,
} from "@steerloop/protocol";
import type { AdapterContext, AgentAdapter } from "./types.js";

interface PendingApproval {
  id: string;
  digest: string;
  expiresAt: number;
}

interface DemoAdapterOptions {
  approvalDelayMs?: number;
  completionDelayMs?: number;
}

export class DemoAdapter implements AgentAdapter {
  readonly name = "demo";
  readonly capabilities = [
    "approval.resolve",
    "session.interrupt",
    "session.prompt",
  ];

  private context: AdapterContext | undefined;
  private pending: PendingApproval | undefined;
  private timers = new Set<NodeJS.Timeout>();
  private readonly approvalDelayMs: number;
  private readonly completionDelayMs: number;
  private sessionId = "";

  constructor(options: DemoAdapterOptions = {}) {
    this.approvalDelayMs = options.approvalDelayMs ?? 2_500;
    this.completionDelayMs = options.completionDelayMs ?? 2_000;
  }

  async start(context: AdapterContext): Promise<void> {
    this.context = context;
    this.sessionId = `demo-${context.hostId}`;
    this.emit({
      type: "session.upserted",
      payload: {
        title: "Prepare the Steerloop alpha",
        cwd: "/workspace/steerloop",
        source: "demo",
        status: "running",
      },
    });
    this.emit({
      type: "session.activity",
      payload: {
        activityId: randomUUID(),
        kind: "analysis",
        summary: "Reviewing the implementation plan and repository state",
      },
    });
    this.schedule(() => this.requestApproval(), this.approvalDelayMs);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  async handleCommand(command: CommandEnvelope): Promise<void> {
    if (command.sessionId !== this.sessionId) {
      throw new Error("Unknown demo session");
    }

    switch (command.command.type) {
      case "approval.resolve":
        this.resolveApproval(command);
        return;
      case "session.interrupt":
        this.pending = undefined;
        await this.stop();
        this.emit({
          type: "session.status.changed",
          payload: { status: "interrupted", detail: "Interrupted from Steerloop" },
        });
        return;
      case "session.prompt":
        this.emit({
          type: "session.activity",
          payload: {
            activityId: randomUUID(),
            kind: "message",
            summary:
              command.command.payload.behavior === "steer"
                ? "Guidance injected into the active run"
                : "Guidance queued for the next turn",
            detail: command.command.payload.text,
          },
        });
    }
  }

  private requestApproval(): void {
    const approvalId = randomUUID();
    const material = canonicalizeApproval({
      approvalId,
      kind: "command",
      command: "npm run check",
      cwd: "/workspace/steerloop",
      reason: "Run the repository quality gates before completing the milestone",
    });
    const digest = createHash("sha256").update(material).digest("hex");
    const expiresAt = Date.now() + 5 * 60_000;
    this.pending = { id: approvalId, digest, expiresAt };
    this.emit({
      type: "approval.requested",
      payload: {
        approvalId,
        kind: "command",
        title: "Run repository quality gates",
        reason: "Run tests, type checking, and production builds",
        command: "npm run check",
        cwd: "/workspace/steerloop",
        requestDigest: digest,
        expiresAt: new Date(expiresAt).toISOString(),
      },
    });
  }

  private resolveApproval(command: CommandEnvelope): void {
    if (command.command.type !== "approval.resolve") return;
    const pending = this.pending;
    if (pending === undefined) throw new Error("No approval is pending");
    if (pending.expiresAt <= Date.now()) {
      this.pending = undefined;
      throw new Error("Approval request has expired");
    }
    if (
      command.command.payload.approvalId !== pending.id ||
      command.command.payload.requestDigest !== pending.digest
    ) {
      throw new Error("Approval request digest mismatch");
    }

    this.pending = undefined;
    const decision = command.command.payload.decision;
    this.emit({
      type: "approval.resolved",
      payload: {
        approvalId: pending.id,
        decision,
        resolvedAt: new Date().toISOString(),
      },
    });

    if (decision !== "approve_once") {
      this.emit({
        type: "session.status.changed",
        payload: {
          status: "interrupted",
          detail: "The requested command was not approved",
        },
      });
      return;
    }

    this.emit({
      type: "session.activity",
      payload: {
        activityId: randomUUID(),
        kind: "test",
        summary: "Running type checks, tests, and builds",
        detail: "npm run check",
      },
    });
    this.schedule(() => {
      this.emit({
        type: "session.diff.updated",
        payload: {
          summary: "Protocol, relay, agent, and mobile console prepared",
          filesChanged: 18,
          additions: 1_240,
          deletions: 0,
        },
      });
      this.emit({
        type: "session.status.changed",
        payload: {
          status: "completed",
          detail: "All quality gates passed",
        },
      });
    }, this.completionDelayMs);
  }

  private emit(event: NormalizedEvent): void {
    if (this.context === undefined) throw new Error("Demo adapter is not started");
    this.context.emit(this.sessionId, event);
  }

  private schedule(callback: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delayMs);
    this.timers.add(timer);
  }
}

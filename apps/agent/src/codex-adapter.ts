import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizeApproval,
  type ApprovalDecision,
  type CommandEnvelope,
  type NormalizedEvent,
  type SessionStatus,
} from "@steerloop/protocol";
import {
  CodexAppServerClient,
  type JsonRpcServerMessage,
} from "./codex-app-server.js";
import type { AdapterContext, AgentAdapter } from "./types.js";

type RequestId = string | number;

interface PendingCodexApproval {
  approvalId: string;
  digest: string;
  expiresAt: number;
  requestId: RequestId;
  kind: "command" | "file_change";
  sessionId: string;
}

interface ThreadSummary {
  id: string;
  preview?: string;
  name?: string | null;
  cwd?: string;
  source?: unknown;
  status?: { type?: string; activeFlags?: string[] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mapThreadStatus(status: unknown): SessionStatus {
  const record = asRecord(status);
  if (record.type === "active") {
    const flags = Array.isArray(record.activeFlags) ? record.activeFlags : [];
    if (flags.includes("waitingOnApproval")) return "waiting_approval";
    if (flags.includes("waitingOnUserInput")) return "waiting_input";
    return "running";
  }
  if (record.type === "systemError") return "failed";
  return "idle";
}

function approvalDecision(decision: ApprovalDecision): "accept" | "decline" | "cancel" {
  if (decision === "approve_once") return "accept";
  return decision;
}

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  readonly capabilities = [
    "approval.resolve",
    "session.interrupt",
    "session.prompt",
  ];

  private context: AdapterContext | undefined;
  private readonly pendingApprovals = new Map<string, PendingCodexApproval>();
  private readonly activeTurns = new Map<string, string>();
  private readonly loadedThreads = new Set<string>();
  private readonly queuedPrompts = new Map<string, string[]>();
  private readonly client: CodexAppServerClient;

  constructor(command = "codex") {
    this.client = new CodexAppServerClient({
      command,
      onNotification: (message) => this.handleNotification(message),
      onServerRequest: (message) => this.handleServerRequest(message),
      onStderr: (line) => console.error(`[codex] ${line}`),
    });
  }

  async start(context: AdapterContext): Promise<void> {
    this.context = context;
    await this.client.start();
    const response = asRecord(
      await this.client.request("thread/list", {
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
      }),
    );
    const threads = Array.isArray(response.data) ? response.data : [];
    for (const value of threads) this.emitThread(value as ThreadSummary);
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  async handleCommand(command: CommandEnvelope): Promise<void> {
    switch (command.command.type) {
      case "approval.resolve":
        this.resolveApproval(command);
        return;
      case "session.interrupt": {
        const turnId = this.activeTurns.get(command.sessionId);
        if (turnId === undefined) throw new Error("Session has no active turn");
        await this.client.request("turn/interrupt", {
          threadId: command.sessionId,
          turnId,
        });
        return;
      }
      case "session.prompt":
        await this.sendPrompt(
          command.sessionId,
          command.command.payload.text,
          command.command.payload.behavior,
        );
    }
  }

  private emit(sessionId: string | undefined, event: NormalizedEvent): void {
    if (this.context === undefined) throw new Error("Codex adapter is not started");
    this.context.emit(sessionId, event);
  }

  private emitThread(thread: ThreadSummary): void {
    this.emit(thread.id, {
      type: "session.upserted",
      payload: {
        title: thread.name ?? thread.preview ?? thread.id,
        ...(optionalString(thread.cwd) === undefined ? {} : { cwd: thread.cwd }),
        source: "codex",
        status: mapThreadStatus(thread.status),
      },
    });
  }

  private async ensureLoaded(threadId: string): Promise<void> {
    if (this.loadedThreads.has(threadId)) return;
    await this.client.request("thread/resume", { threadId });
    this.loadedThreads.add(threadId);
  }

  private async startTurn(threadId: string, text: string): Promise<void> {
    await this.ensureLoaded(threadId);
    await this.client.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  private async sendPrompt(
    threadId: string,
    text: string,
    behavior: "queue" | "steer",
  ): Promise<void> {
    const activeTurnId = this.activeTurns.get(threadId);
    if (activeTurnId === undefined) {
      await this.startTurn(threadId, text);
      return;
    }

    if (behavior === "steer") {
      await this.client.request("turn/steer", {
        threadId,
        expectedTurnId: activeTurnId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      return;
    }

    const queue = this.queuedPrompts.get(threadId) ?? [];
    this.queuedPrompts.set(threadId, [...queue, text].slice(-20));
  }

  private resolveApproval(command: CommandEnvelope): void {
    if (command.command.type !== "approval.resolve") return;
    const payload = command.command.payload;
    const pending = this.pendingApprovals.get(payload.approvalId);
    if (pending === undefined) throw new Error("Approval is no longer pending");
    if (pending.sessionId !== command.sessionId) {
      throw new Error("Approval session mismatch");
    }
    if (pending.expiresAt <= Date.now()) {
      this.pendingApprovals.delete(pending.approvalId);
      throw new Error("Approval request has expired");
    }
    if (pending.digest !== payload.requestDigest) {
      throw new Error("Approval request digest mismatch");
    }

    this.pendingApprovals.delete(pending.approvalId);
    this.client.respond(pending.requestId, {
      decision: approvalDecision(payload.decision),
    });
    this.emit(command.sessionId, {
      type: "approval.resolved",
      payload: {
        approvalId: pending.approvalId,
        decision: payload.decision,
        resolvedAt: new Date().toISOString(),
      },
    });
  }

  private handleServerRequest(
    message: JsonRpcServerMessage & { id: RequestId },
  ): void {
    const params = asRecord(message.params);
    if (
      message.method !== "item/commandExecution/requestApproval" &&
      message.method !== "item/fileChange/requestApproval"
    ) {
      this.client.respondError(message.id, -32_601, "Unsupported remote request");
      return;
    }

    const sessionId = optionalString(params.threadId);
    const itemId = optionalString(params.itemId);
    if (sessionId === undefined || itemId === undefined) {
      this.client.respondError(message.id, -32_602, "Malformed approval request");
      return;
    }

    const requestKind =
      message.method === "item/commandExecution/requestApproval"
        ? "command"
        : "file_change";
    const networkContext = asRecord(params.networkApprovalContext);
    const kind = optionalString(networkContext.host) === undefined ? requestKind : "network";
    const approvalId = `${sessionId}:${itemId}:${String(params.approvalId ?? message.id)}`;
    const material = canonicalizeApproval({
      approvalId,
      kind,
      ...(optionalString(params.command) === undefined
        ? {}
        : { command: params.command as string }),
      ...(optionalString(params.cwd) === undefined ? {} : { cwd: params.cwd as string }),
      ...(optionalString(params.reason) === undefined
        ? {}
        : { reason: params.reason as string }),
      ...(optionalString(params.grantRoot) === undefined
        ? {}
        : { grantRoot: params.grantRoot as string }),
      ...(optionalString(networkContext.host) === undefined
        ? {}
        : { networkHost: networkContext.host as string }),
      ...(optionalString(networkContext.protocol) === undefined
        ? {}
        : { networkProtocol: networkContext.protocol as string }),
    });
    const digest = createHash("sha256").update(material).digest("hex");
    const expiresAt = Date.now() + 5 * 60_000;
    this.pendingApprovals.set(approvalId, {
      approvalId,
      digest,
      expiresAt,
      requestId: message.id,
      kind: requestKind,
      sessionId,
    });

    this.emit(sessionId, {
      type: "approval.requested",
      payload: {
        approvalId,
        kind,
        title:
          kind === "network"
            ? `Allow network access to ${String(networkContext.host)}`
            : requestKind === "command"
              ? "Allow command execution"
              : "Allow file changes",
        ...(optionalString(params.reason) === undefined
          ? {}
          : { reason: params.reason as string }),
        ...(optionalString(params.command) === undefined
          ? {}
          : { command: params.command as string }),
        ...(optionalString(params.cwd) === undefined
          ? {}
          : { cwd: params.cwd as string }),
        ...(optionalString(params.grantRoot) === undefined
          ? {}
          : { grantRoot: params.grantRoot as string }),
        ...(optionalString(networkContext.host) === undefined
          ? {}
          : { networkHost: networkContext.host as string }),
        ...(optionalString(networkContext.protocol) === undefined
          ? {}
          : { networkProtocol: networkContext.protocol as string }),
        requestDigest: digest,
        expiresAt: new Date(expiresAt).toISOString(),
      },
    });
  }

  private handleNotification(message: JsonRpcServerMessage): void {
    const params = asRecord(message.params);
    const sessionId = optionalString(params.threadId);

    switch (message.method) {
      case "thread/started": {
        const thread = asRecord(params.thread) as unknown as ThreadSummary;
        if (typeof thread.id === "string") {
          this.loadedThreads.add(thread.id);
          this.emitThread(thread);
        }
        break;
      }
      case "thread/status/changed":
        if (sessionId !== undefined) {
          this.emit(sessionId, {
            type: "session.status.changed",
            payload: { status: mapThreadStatus(params.status) },
          });
        }
        break;
      case "turn/started": {
        const turn = asRecord(params.turn);
        if (sessionId !== undefined && typeof turn.id === "string") {
          this.activeTurns.set(sessionId, turn.id);
          this.emit(sessionId, {
            type: "session.status.changed",
            payload: { status: "running" },
          });
        }
        break;
      }
      case "turn/completed": {
        const turn = asRecord(params.turn);
        if (sessionId === undefined) break;
        this.activeTurns.delete(sessionId);
        const status = turn.status;
        this.emit(sessionId, {
          type: "session.status.changed",
          payload: {
            status:
              status === "completed"
                ? "completed"
                : status === "interrupted"
                  ? "interrupted"
                  : "failed",
            ...(optionalString(asRecord(turn.error).message) === undefined
              ? {}
              : { detail: asRecord(turn.error).message as string }),
          },
        });
        const queue = this.queuedPrompts.get(sessionId) ?? [];
        const next = queue[0];
        if (next !== undefined) {
          this.queuedPrompts.set(sessionId, queue.slice(1));
          void this.startTurn(sessionId, next);
        }
        break;
      }
      case "item/agentMessage/delta":
        if (sessionId !== undefined && typeof params.delta === "string") {
          this.emit(sessionId, {
            type: "session.message.delta",
            payload: {
              messageId: String(params.itemId ?? randomUUID()),
              delta: params.delta,
            },
          });
        }
        break;
      case "turn/diff/updated":
        if (sessionId !== undefined && typeof params.diff === "string") {
          const files = new Set(
            [...params.diff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1]),
          );
          const additions = (params.diff.match(/^\+(?!\+\+)/gm) ?? []).length;
          const deletions = (params.diff.match(/^-(?!--)/gm) ?? []).length;
          this.emit(sessionId, {
            type: "session.diff.updated",
            payload: {
              summary: `${files.size} changed file${files.size === 1 ? "" : "s"}`,
              filesChanged: files.size,
              additions,
              deletions,
            },
          });
        }
        break;
      case "item/started": {
        if (sessionId === undefined) break;
        const item = asRecord(params.item);
        if (item.type === "commandExecution") {
          const command = Array.isArray(item.command)
            ? item.command.join(" ")
            : String(item.command ?? "command");
          this.emit(sessionId, {
            type: "session.activity",
            payload: {
              activityId: String(item.id ?? randomUUID()),
              kind: "command",
              summary: command,
              ...(optionalString(item.cwd) === undefined
                ? {}
                : { detail: `Working directory: ${String(item.cwd)}` }),
            },
          });
        } else if (item.type === "fileChange") {
          this.emit(sessionId, {
            type: "session.activity",
            payload: {
              activityId: String(item.id ?? randomUUID()),
              kind: "file_change",
              summary: "Preparing file changes",
            },
          });
        }
        break;
      }
      case "error":
        if (sessionId !== undefined) {
          const error = asRecord(params.error);
          this.emit(sessionId, {
            type: "session.status.changed",
            payload: {
              status: "failed",
              detail: optionalString(error.message) ?? "Codex turn failed",
            },
          });
        }
    }
  }
}

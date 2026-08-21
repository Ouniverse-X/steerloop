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
  kind: "command" | "file_change" | "permissions";
  requestedPermissions?: Record<string, unknown>;
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

const FIELD_LIMITS = {
  sessionTitle: 512,
  cwd: 4_096,
  approvalTitle: 512,
  approvalReason: 4_096,
  command: 16_384,
  networkHost: 512,
  networkProtocol: 32,
  statusDetail: 2_048,
  activitySummary: 2_048,
  activityDetail: 16_384,
  messageDelta: 16_384,
  diffSummary: 4_096,
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function limitCodexString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

function optionalLimitedString(value: unknown, maxLength: number): string | undefined {
  const text = optionalString(value);
  return text === undefined ? undefined : limitCodexString(text, maxLength);
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

function displayPath(value: unknown): string {
  if (typeof value === "string") return value;
  const path = asRecord(value);
  if (typeof path.path === "string") return path.path;
  if (typeof path.pattern === "string") return path.pattern;
  if (typeof path.value === "string") return path.value;
  return JSON.stringify(value).slice(0, 900);
}

export function summarizeRequestedPermissions(value: unknown): string[] {
  const permissions = asRecord(value);
  const summary: string[] = [];
  const network = asRecord(permissions.network);
  if (network.enabled === true) summary.push("Enable network access");

  const fileSystem = asRecord(permissions.fileSystem);
  for (const access of ["read", "write"] as const) {
    const paths = fileSystem[access];
    if (Array.isArray(paths)) {
      for (const path of paths) summary.push(`${access}: ${displayPath(path)}`);
    }
  }
  if (Array.isArray(fileSystem.entries)) {
    for (const entryValue of fileSystem.entries) {
      const entry = asRecord(entryValue);
      summary.push(`${String(entry.access ?? "access")}: ${displayPath(entry.path)}`);
    }
  }
  return summary.slice(0, 128).map((item) => item.slice(0, 1_024));
}

function grantedPermissions(value: Record<string, unknown>): Record<string, unknown> {
  const granted: Record<string, unknown> = {};
  if (typeof value.network === "object" && value.network !== null) {
    granted.network = value.network;
  }
  if (typeof value.fileSystem === "object" && value.fileSystem !== null) {
    granted.fileSystem = value.fileSystem;
  }
  return granted;
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
    const title = optionalLimitedString(thread.name, FIELD_LIMITS.sessionTitle)
      ?? optionalLimitedString(thread.preview, FIELD_LIMITS.sessionTitle)
      ?? limitCodexString(thread.id, FIELD_LIMITS.sessionTitle);
    const cwd = optionalLimitedString(thread.cwd, FIELD_LIMITS.cwd);

    this.emit(thread.id, {
      type: "session.upserted",
      payload: {
        title,
        ...(cwd === undefined ? {} : { cwd }),
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
    if (pending.kind === "permissions") {
      this.client.respond(pending.requestId, {
        permissions:
          payload.decision === "approve_once" && pending.requestedPermissions !== undefined
            ? grantedPermissions(pending.requestedPermissions)
            : {},
        scope: "turn",
      });
    } else {
      this.client.respond(pending.requestId, {
        decision: approvalDecision(payload.decision),
      });
    }
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
      message.method !== "item/fileChange/requestApproval" &&
      message.method !== "item/permissions/requestApproval"
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

    const requestKind = message.method === "item/commandExecution/requestApproval"
      ? "command"
      : message.method === "item/fileChange/requestApproval"
        ? "file_change"
        : "permissions";
    const networkContext = asRecord(params.networkApprovalContext);
    const networkHost = optionalLimitedString(networkContext.host, FIELD_LIMITS.networkHost);
    const networkProtocol = optionalLimitedString(networkContext.protocol, FIELD_LIMITS.networkProtocol);
    const kind = networkHost === undefined ? requestKind : "network";
    const rawPermissions = asRecord(params.permissions);
    const requestedPermissions = summarizeRequestedPermissions(rawPermissions);
    const approvalId = `${sessionId}:${itemId}:${String(params.approvalId ?? message.id)}`;
    const command = optionalLimitedString(params.command, FIELD_LIMITS.command);
    const cwd = optionalLimitedString(params.cwd, FIELD_LIMITS.cwd);
    const reason = optionalLimitedString(params.reason, FIELD_LIMITS.approvalReason);
    const grantRoot = optionalLimitedString(params.grantRoot, FIELD_LIMITS.cwd);
    const material = canonicalizeApproval({
      approvalId,
      kind,
      ...(command === undefined ? {} : { command }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(reason === undefined ? {} : { reason }),
      ...(grantRoot === undefined ? {} : { grantRoot }),
      ...(networkHost === undefined ? {} : { networkHost }),
      ...(networkProtocol === undefined ? {} : { networkProtocol }),
      ...(requestedPermissions.length === 0 ? {} : { requestedPermissions }),
    });
    const digest = createHash("sha256").update(material).digest("hex");
    const expiresAt = Date.now() + 5 * 60_000;
    this.pendingApprovals.set(approvalId, {
      approvalId,
      digest,
      expiresAt,
      requestId: message.id,
      kind: requestKind,
      ...(requestKind === "permissions"
        ? { requestedPermissions: rawPermissions }
        : {}),
      sessionId,
    });

    this.emit(sessionId, {
      type: "approval.requested",
      payload: {
        approvalId,
        kind,
        title:
          kind === "network"
            ? limitCodexString(`Allow network access to ${networkHost}`, FIELD_LIMITS.approvalTitle)
            : requestKind === "command"
              ? "Allow command execution"
              : requestKind === "file_change"
                ? "Allow file changes"
                : "Grant additional permissions",
        ...(reason === undefined ? {} : { reason }),
        ...(command === undefined ? {} : { command }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(grantRoot === undefined ? {} : { grantRoot }),
        ...(networkHost === undefined ? {} : { networkHost }),
        ...(networkProtocol === undefined ? {} : { networkProtocol }),
        ...(requestedPermissions.length === 0 ? {} : { requestedPermissions }),
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
        const errorDetail = optionalLimitedString(
          asRecord(turn.error).message,
          FIELD_LIMITS.statusDetail,
        );
        this.emit(sessionId, {
          type: "session.status.changed",
          payload: {
            status:
              status === "completed"
                ? "completed"
                : status === "interrupted"
                  ? "interrupted"
                  : "failed",
            ...(errorDetail === undefined ? {} : { detail: errorDetail }),
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
              delta: limitCodexString(params.delta, FIELD_LIMITS.messageDelta),
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
              summary: limitCodexString(
                `${files.size} changed file${files.size === 1 ? "" : "s"}`,
                FIELD_LIMITS.diffSummary,
              ),
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
          const cwd = optionalLimitedString(item.cwd, FIELD_LIMITS.cwd);
          this.emit(sessionId, {
            type: "session.activity",
            payload: {
              activityId: String(item.id ?? randomUUID()),
              kind: "command",
              summary: limitCodexString(command, FIELD_LIMITS.activitySummary),
              ...(cwd === undefined
                ? {}
                : { detail: limitCodexString(`Working directory: ${cwd}`, FIELD_LIMITS.activityDetail) }),
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
              detail: optionalLimitedString(error.message, FIELD_LIMITS.statusDetail) ?? "Codex turn failed",
            },
          });
        }
    }
  }
}

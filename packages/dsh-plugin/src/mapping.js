import { canonicalizeApproval, sha256Hex } from "./protocol.js";

const FIELD_LIMITS = {
  title: 512,
  detail: 16_384,
  summary: 2_048,
  command: 16_384,
  reason: 4_096,
};

function asString(value) {
  return typeof value === "string" ? value : undefined;
}

function limit(value, max) {
  if (typeof value !== "string") return undefined;
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function sessionIdOf(session) {
  return String(session?.id ?? "dsh-session");
}

function eventData(event) {
  return event?.data && typeof event.data === "object" ? event.data : {};
}

function compactJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export class HarnessEventMapper {
  constructor() {
    this.seenSessions = new Set();
    this.toolCalls = new Map();
  }

  rememberToolCall(sessionId, data) {
    if (typeof data.callId !== "string") return;
    const args = parseToolArguments(data.arguments);
    this.toolCalls.set(`${sessionId}:${data.callId}`, {
      name: typeof data.name === "string" ? data.name : "tool",
      arguments: args,
      rawArguments: typeof data.arguments === "string" ? data.arguments : undefined,
    });
  }

  findToolCall(sessionId, callId) {
    if (typeof callId !== "string") return undefined;
    return this.toolCalls.get(`${sessionId}:${callId}`);
  }

  mapSessionEvent(session, event) {
    const sessionId = sessionIdOf(session);
    const frames = [];
    if (!this.seenSessions.has(sessionId)) {
      this.seenSessions.add(sessionId);
      frames.push({
        sessionId,
        event: {
          type: "session.upserted",
          payload: {
            title: limit(String(session?.header?.title ?? session?.header?.cwd ?? sessionId), FIELD_LIMITS.title) ?? sessionId,
            source: "deepseek-harness",
            status: "running",
          },
        },
      });
    }

    const type = String(event?.type ?? "");
    const data = eventData(event);
    switch (type) {
      case "turn/start":
        frames.push(activity(sessionId, `dsh-turn-${data.turn}-start`, "analysis", `Turn ${data.turn} started`));
        break;
      case "turn/end":
        frames.push(activity(sessionId, `dsh-turn-${data.turn}-end`, "analysis", `Turn ${data.turn} ended: ${String(data.reason ?? "done")}`));
        frames.push({
          sessionId,
          event: { type: "session.status.changed", payload: { status: "idle" } },
        });
        break;
      case "assistant/chunk": {
        const chunk = chunkText(data.chunk);
        if (chunk !== undefined) {
          frames.push({
            sessionId,
            event: {
              type: "session.message.delta",
              payload: {
                messageId: `dsh-assistant-${String(data.turn ?? "x")}-${String(data.step ?? "x")}`,
                delta: chunk,
              },
            },
          });
        }
        break;
      }
      case "assistant/message":
        frames.push(activity(sessionId, `dsh-assistant-${data.turn}-${data.step}`, "message", "Assistant message completed", summarizeMessage(data.message)));
        break;
      case "tool/call":
        this.rememberToolCall(sessionId, data);
        frames.push(activity(sessionId, `dsh-tool-${String(data.callId ?? Date.now())}`, toolKind(data.name), `Tool requested: ${String(data.name ?? "tool")}`, toolDetail(data)));
        break;
      case "tool/result":
        frames.push(activity(sessionId, `dsh-tool-result-${String(data.callId ?? Date.now())}`, "test", `Tool completed: ${String(data.callId ?? "tool")}`, toolResultDetail(data)));
        break;
      case "approval/decided":
        frames.push({
          sessionId,
          event: {
            type: "approval.resolved",
            payload: {
              approvalId: `dsh-${String(data.id ?? "approval")}`,
              decision: outcomeToDecision(data.outcome),
              resolvedAt: new Date().toISOString(),
            },
          },
        });
        break;
      default:
        break;
    }
    return frames;
  }

  createApprovalRequest(req, approvalId, expiresAt) {
    const sessionId = sessionIdOf(req.agent?.session);
    const call = this.findToolCall(sessionId, req.callId);
    const command = commandFromCall(call);
    const title = limit(`Approve ${req.toolName ?? call?.name ?? "Harness action"}`, FIELD_LIMITS.title);
    const reason = limit(req.reason ?? approvalReason(call), FIELD_LIMITS.reason);
    const requestedPermissions = [
      `tool:${String(req.toolName ?? call?.name ?? "unknown")}`,
      ...(typeof req.callId === "string" ? [`call:${req.callId}`] : []),
    ];
    const material = {
      approvalId,
      kind: command === undefined ? "permissions" : "command",
      title,
      reason,
      command,
      requestedPermissions,
    };
    return {
      sessionId,
      payload: {
        approvalId,
        kind: material.kind,
        title,
        ...(reason === undefined ? {} : { reason }),
        ...(command === undefined ? {} : { command }),
        requestedPermissions,
        requestDigest: sha256Hex(canonicalizeApproval(material)),
        expiresAt,
      },
    };
  }
}

function activity(sessionId, activityId, kind, summary, detail) {
  return {
    sessionId,
    event: {
      type: "session.activity",
      payload: {
        activityId,
        kind,
        summary: limit(summary, FIELD_LIMITS.summary) ?? "Harness activity",
        ...(detail === undefined ? {} : { detail: limit(detail, FIELD_LIMITS.detail) }),
      },
    },
  };
}

function parseToolArguments(value) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function chunkText(chunk) {
  if (typeof chunk === "string") return chunk;
  if (!chunk || typeof chunk !== "object") return undefined;
  if (typeof chunk.text === "string") return chunk.text;
  if (typeof chunk.delta === "string") return chunk.delta;
  return undefined;
}

function summarizeMessage(message) {
  if (!message || typeof message !== "object") return undefined;
  return compactJson(message);
}

function toolDetail(data) {
  const args = parseToolArguments(data.arguments);
  return compactJson({
    callId: data.callId,
    arguments: args ?? data.arguments,
  });
}

function toolResultDetail(data) {
  return compactJson({
    callId: data.callId,
    error: data.error,
    message: data.message,
    meta: data.meta,
  });
}

function toolKind(name) {
  const value = String(name ?? "");
  return value.includes("bash") || value.includes("pwsh") || value.includes("shell")
    ? "command"
    : "analysis";
}

function commandFromCall(call) {
  const args = call?.arguments;
  if (!args || typeof args !== "object") return undefined;
  return limit(
    asString(args.command) ?? asString(args.cmd) ?? asString(args.script) ?? asString(args.input),
    FIELD_LIMITS.command,
  );
}

function approvalReason(call) {
  if (call === undefined) return undefined;
  return `DeepSeek Harness requested approval for ${call.name}.`;
}

function outcomeToDecision(outcome) {
  switch (outcome) {
    case "allowed-once":
      return "approve_once";
    case "cancelled":
      return "cancel";
    default:
      return "decline";
  }
}

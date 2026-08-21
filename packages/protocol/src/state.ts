import type {
  ApprovalDecision,
  ApprovalKind,
  EventEnvelope,
  SessionStatus,
} from "./schema.js";

export interface HostView {
  id: string;
  name: string;
  platform: string;
  agentVersion: string;
  capabilities: string[];
  online: boolean;
  lastSeenAt: string;
}

export interface ActivityView {
  id: string;
  kind: "analysis" | "command" | "file_change" | "test" | "message";
  summary: string;
  detail?: string;
  emittedAt: string;
}

export interface DiffView {
  summary: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

export interface SessionView {
  id: string;
  hostId: string;
  title: string;
  source: string;
  status: SessionStatus;
  cwd?: string;
  detail?: string;
  latestMessage: string;
  activities: ActivityView[];
  diff?: DiffView;
  updatedAt: string;
}

export interface ApprovalView {
  id: string;
  hostId: string;
  sessionId: string;
  kind: ApprovalKind;
  title: string;
  requestDigest: string;
  expiresAt: string;
  requestedAt: string;
  status: "pending" | ApprovalDecision;
  reason?: string;
  command?: string;
  cwd?: string;
  grantRoot?: string;
  networkHost?: string;
  networkProtocol?: string;
  requestedPermissions?: string[];
  resolvedAt?: string;
}

export interface ControlPlaneState {
  hosts: Record<string, HostView>;
  sessions: Record<string, SessionView>;
  approvals: Record<string, ApprovalView>;
  lastSequenceByHost: Record<string, number>;
  recentEventIds: string[];
}

const MAX_ACTIVITIES = 30;
const MAX_EVENT_IDS = 2_000;

export function createEmptyState(): ControlPlaneState {
  return {
    hosts: {},
    sessions: {},
    approvals: {},
    lastSequenceByHost: {},
    recentEventIds: [],
  };
}

function placeholderSession(envelope: EventEnvelope): SessionView | undefined {
  if (envelope.sessionId === undefined) {
    return undefined;
  }

  return {
    id: envelope.sessionId,
    hostId: envelope.hostId,
    title: "Untitled session",
    source: "unknown",
    status: "idle",
    latestMessage: "",
    activities: [],
    updatedAt: envelope.emittedAt,
  };
}

function optionalFields<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

export function reduceEvent(
  previous: ControlPlaneState,
  envelope: EventEnvelope,
): ControlPlaneState {
  const lastSequence = previous.lastSequenceByHost[envelope.hostId] ?? 0;
  if (
    envelope.sequence <= lastSequence ||
    previous.recentEventIds.includes(envelope.eventId)
  ) {
    return previous;
  }

  const next: ControlPlaneState = {
    hosts: { ...previous.hosts },
    sessions: { ...previous.sessions },
    approvals: { ...previous.approvals },
    lastSequenceByHost: {
      ...previous.lastSequenceByHost,
      [envelope.hostId]: envelope.sequence,
    },
    recentEventIds: [...previous.recentEventIds, envelope.eventId].slice(
      -MAX_EVENT_IDS,
    ),
  };

  const existingSession =
    envelope.sessionId === undefined
      ? undefined
      : next.sessions[envelope.sessionId] ?? placeholderSession(envelope);

  switch (envelope.event.type) {
    case "host.connected": {
      const payload = envelope.event.payload;
      next.hosts[envelope.hostId] = {
        id: envelope.hostId,
        name: payload.name,
        platform: payload.platform,
        agentVersion: payload.agentVersion,
        capabilities: payload.capabilities,
        online: true,
        lastSeenAt: envelope.emittedAt,
      };
      break;
    }
    case "host.heartbeat": {
      const host = next.hosts[envelope.hostId];
      if (host !== undefined) {
        next.hosts[envelope.hostId] = {
          ...host,
          online: true,
          lastSeenAt: envelope.event.payload.at,
        };
      }
      break;
    }
    case "host.disconnected": {
      const host = next.hosts[envelope.hostId];
      if (host !== undefined) {
        next.hosts[envelope.hostId] = {
          ...host,
          online: false,
          lastSeenAt: envelope.emittedAt,
        };
      }
      for (const session of Object.values(next.sessions)) {
        if (session.hostId === envelope.hostId) {
          next.sessions[session.id] = {
            ...session,
            status: "offline",
            updatedAt: envelope.emittedAt,
          };
        }
      }
      break;
    }
    case "session.upserted": {
      if (envelope.sessionId === undefined) break;
      const payload = envelope.event.payload;
      next.sessions[envelope.sessionId] = optionalFields({
        ...(existingSession ?? placeholderSession(envelope)),
        id: envelope.sessionId,
        hostId: envelope.hostId,
        title: payload.title,
        source: payload.source,
        status: payload.status,
        cwd: payload.cwd,
        latestMessage: existingSession?.latestMessage ?? "",
        activities: existingSession?.activities ?? [],
        updatedAt: envelope.emittedAt,
      }) as SessionView;
      break;
    }
    case "session.status.changed": {
      if (existingSession === undefined) break;
      next.sessions[existingSession.id] = optionalFields({
        ...existingSession,
        status: envelope.event.payload.status,
        detail: envelope.event.payload.detail,
        updatedAt: envelope.emittedAt,
      }) as SessionView;
      break;
    }
    case "session.activity": {
      if (existingSession === undefined) break;
      const payload = envelope.event.payload;
      const activity = optionalFields({
        id: payload.activityId,
        kind: payload.kind,
        summary: payload.summary,
        detail: payload.detail,
        emittedAt: envelope.emittedAt,
      }) as ActivityView;
      next.sessions[existingSession.id] = {
        ...existingSession,
        activities: [...existingSession.activities, activity].slice(-MAX_ACTIVITIES),
        updatedAt: envelope.emittedAt,
      };
      break;
    }
    case "session.message.delta": {
      if (existingSession === undefined) break;
      next.sessions[existingSession.id] = {
        ...existingSession,
        latestMessage: `${existingSession.latestMessage}${envelope.event.payload.delta}`.slice(
          -32_768,
        ),
        updatedAt: envelope.emittedAt,
      };
      break;
    }
    case "session.diff.updated": {
      if (existingSession === undefined) break;
      next.sessions[existingSession.id] = {
        ...existingSession,
        diff: optionalFields({ ...envelope.event.payload }) as DiffView,
        updatedAt: envelope.emittedAt,
      };
      break;
    }
    case "approval.requested": {
      if (envelope.sessionId === undefined || existingSession === undefined) break;
      const payload = envelope.event.payload;
      next.approvals[payload.approvalId] = optionalFields({
        id: payload.approvalId,
        hostId: envelope.hostId,
        sessionId: envelope.sessionId,
        kind: payload.kind,
        title: payload.title,
        requestDigest: payload.requestDigest,
        expiresAt: payload.expiresAt,
        requestedAt: envelope.emittedAt,
        status: "pending" as const,
        reason: payload.reason,
        command: payload.command,
        cwd: payload.cwd,
        grantRoot: payload.grantRoot,
        networkHost: payload.networkHost,
        networkProtocol: payload.networkProtocol,
        requestedPermissions: payload.requestedPermissions,
      }) as ApprovalView;
      next.sessions[existingSession.id] = {
        ...existingSession,
        status: "waiting_approval",
        updatedAt: envelope.emittedAt,
      };
      break;
    }
    case "approval.resolved": {
      const approval = next.approvals[envelope.event.payload.approvalId];
      if (approval !== undefined) {
        next.approvals[approval.id] = {
          ...approval,
          status: envelope.event.payload.decision,
          resolvedAt: envelope.event.payload.resolvedAt,
        };
        const session = next.sessions[approval.sessionId];
        if (session !== undefined && session.status === "waiting_approval") {
          next.sessions[session.id] = {
            ...session,
            status:
              envelope.event.payload.decision === "approve_once"
                ? "running"
                : "interrupted",
            updatedAt: envelope.emittedAt,
          };
        }
      }
      break;
    }
  }

  return next;
}

export function reduceEvents(events: EventEnvelope[]): ControlPlaneState {
  return events.reduce(reduceEvent, createEmptyState());
}

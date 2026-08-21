import { z } from "zod";

export const PROTOCOL_VERSION = "0.1.0" as const;

const idSchema = z.string().min(1).max(256);
const timestampSchema = z.string().datetime({ offset: true });

export const sessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting_approval",
  "waiting_input",
  "completed",
  "failed",
  "interrupted",
  "offline",
]);

export const approvalKindSchema = z.enum([
  "command",
  "file_change",
  "network",
  "permissions",
]);

export const approvalDecisionSchema = z.enum([
  "approve_once",
  "decline",
  "cancel",
]);

export const normalizedEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("host.connected"),
    payload: z.object({
      name: z.string().min(1).max(256),
      platform: z.string().min(1).max(128),
      agentVersion: z.string().min(1).max(64),
      capabilities: z.array(z.string().min(1).max(128)).max(64),
    }),
  }),
  z.object({
    type: z.literal("host.heartbeat"),
    payload: z.object({ at: timestampSchema }),
  }),
  z.object({
    type: z.literal("host.disconnected"),
    payload: z.object({ reason: z.string().max(512).optional() }),
  }),
  z.object({
    type: z.literal("session.upserted"),
    payload: z.object({
      title: z.string().min(1).max(512),
      cwd: z.string().max(4096).optional(),
      source: z.string().min(1).max(64),
      status: sessionStatusSchema,
    }),
  }),
  z.object({
    type: z.literal("session.status.changed"),
    payload: z.object({
      status: sessionStatusSchema,
      detail: z.string().max(2048).optional(),
    }),
  }),
  z.object({
    type: z.literal("session.activity"),
    payload: z.object({
      activityId: idSchema,
      kind: z.enum(["analysis", "command", "file_change", "test", "message"]),
      summary: z.string().min(1).max(2048),
      detail: z.string().max(16_384).optional(),
    }),
  }),
  z.object({
    type: z.literal("session.message.delta"),
    payload: z.object({
      messageId: idSchema,
      delta: z.string().max(16_384),
    }),
  }),
  z.object({
    type: z.literal("session.diff.updated"),
    payload: z.object({
      summary: z.string().max(4096),
      filesChanged: z.number().int().nonnegative().optional(),
      additions: z.number().int().nonnegative().optional(),
      deletions: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    type: z.literal("approval.requested"),
    payload: z.object({
      approvalId: idSchema,
      kind: approvalKindSchema,
      title: z.string().min(1).max(512),
      reason: z.string().max(4096).optional(),
      command: z.string().max(16_384).optional(),
      cwd: z.string().max(4096).optional(),
      grantRoot: z.string().max(4096).optional(),
      networkHost: z.string().max(512).optional(),
      networkProtocol: z.string().max(32).optional(),
      requestedPermissions: z.array(z.string().min(1).max(1024)).max(128).optional(),
      requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: timestampSchema,
    }),
  }),
  z.object({
    type: z.literal("approval.resolved"),
    payload: z.object({
      approvalId: idSchema,
      decision: approvalDecisionSchema,
      resolvedAt: timestampSchema,
    }),
  }),
]);

export const eventEnvelopeSchema = z.object({
  kind: z.literal("event"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  eventId: idSchema,
  sequence: z.number().int().positive(),
  hostId: idSchema,
  sessionId: idSchema.optional(),
  emittedAt: timestampSchema,
  event: normalizedEventSchema,
});

export const normalizedCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approval.resolve"),
    payload: z.object({
      approvalId: idSchema,
      requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      decision: approvalDecisionSchema,
      authorization: z.object({
        deviceId: idSchema,
        algorithm: z.literal("ECDSA-P256-SHA256"),
        signedAt: timestampSchema,
        signature: z.string().min(64).max(512).regex(/^[A-Za-z0-9_-]+$/),
      }).optional(),
    }),
  }),
  z.object({
    type: z.literal("session.interrupt"),
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("session.prompt"),
    payload: z.object({
      text: z.string().min(1).max(16_384),
      behavior: z.enum(["queue", "steer"]),
    }),
  }),
]);

export const commandEnvelopeSchema = z.object({
  kind: z.literal("command"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: idSchema,
  hostId: idSchema,
  sessionId: idSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  command: normalizedCommandSchema,
});

export const commandResultSchema = z.object({
  kind: z.literal("command.result"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: idSchema,
  hostId: idSchema,
  ok: z.boolean(),
  error: z.string().max(2048).optional(),
});

export const pairingOfferFrameSchema = z.object({
  kind: z.literal("pairing.offer"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  hostId: idSchema,
  code: z.string().min(6).max(32).regex(/^[A-Z0-9-]+$/),
  expiresAt: timestampSchema,
});

export const authFrameSchema = z.discriminatedUnion("role", [
  z.object({
    kind: z.literal("auth"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    role: z.literal("agent"),
    token: z.string().min(1).max(4096),
    hostId: idSchema,
  }),
  z.object({
    kind: z.literal("auth"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    role: z.literal("client"),
    token: z.string().min(1).max(4096),
  }),
]);

export const authResultSchema = z.object({
  kind: z.literal("auth.result"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  ok: z.boolean(),
  error: z.string().max(2048).optional(),
});

export const snapshotFrameSchema = z.object({
  kind: z.literal("snapshot"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  events: z.array(eventEnvelopeSchema).max(2_000),
});

export const clientToRelayFrameSchema = z.union([
  authFrameSchema,
  commandEnvelopeSchema,
]);

export const agentToRelayFrameSchema = z.union([
  authFrameSchema,
  eventEnvelopeSchema,
  commandResultSchema,
  pairingOfferFrameSchema,
]);

export const relayToClientFrameSchema = z.union([
  authResultSchema,
  eventEnvelopeSchema,
  commandResultSchema,
  snapshotFrameSchema,
]);

export const relayToAgentFrameSchema = z.union([
  authResultSchema,
  commandEnvelopeSchema,
]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type ApprovalKind = z.infer<typeof approvalKindSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type NormalizedCommand = z.infer<typeof normalizedCommandSchema>;
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type PairingOfferFrame = z.infer<typeof pairingOfferFrameSchema>;
export type AuthFrame = z.infer<typeof authFrameSchema>;
export type AuthResult = z.infer<typeof authResultSchema>;
export type SnapshotFrame = z.infer<typeof snapshotFrameSchema>;
export type ClientToRelayFrame = z.infer<typeof clientToRelayFrameSchema>;
export type AgentToRelayFrame = z.infer<typeof agentToRelayFrameSchema>;
export type RelayToClientFrame = z.infer<typeof relayToClientFrameSchema>;
export type RelayToAgentFrame = z.infer<typeof relayToAgentFrameSchema>;

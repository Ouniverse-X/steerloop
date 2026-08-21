import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  eventEnvelopeSchema,
  type EventEnvelope,
  type NormalizedEvent,
} from "@steerloop/protocol";

export class EventFactory {
  private sequence = 0;

  constructor(private readonly hostId: string) {}

  create(
    sessionId: string | undefined,
    event: NormalizedEvent,
  ): EventEnvelope {
    this.sequence += 1;
    return eventEnvelopeSchema.parse({
      kind: "event",
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      sequence: this.sequence,
      hostId: this.hostId,
      ...(sessionId === undefined ? {} : { sessionId }),
      emittedAt: new Date().toISOString(),
      event,
    });
  }
}

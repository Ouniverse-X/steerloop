import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@steerloop/protocol";
import { describe, expect, it } from "vitest";
import { EventJournal } from "../src/event-journal.js";

function event(sequence: number): EventEnvelope {
  return eventEnvelopeSchema.parse({
    kind: "event",
    protocolVersion: PROTOCOL_VERSION,
    eventId: `journal-event-${sequence}`,
    sequence,
    hostId: "journal-host",
    emittedAt: new Date(sequence * 1_000).toISOString(),
    event: { type: "host.heartbeat", payload: { at: new Date(sequence * 1_000).toISOString() } },
  });
}

describe("event journal", () => {
  it("recovers the bounded history after reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steerloop-journal-"));
    const path = join(directory, "events.jsonl");
    const journal = await EventJournal.open({ path, maxEvents: 2, syncWrites: true });
    await journal.append(event(1));
    await journal.append(event(2));
    await journal.append(event(3));
    await journal.close();

    const recovered = await EventJournal.open({ path, maxEvents: 2, syncWrites: true });
    expect(recovered.snapshot().map((value) => value.sequence)).toEqual([2, 3]);
    await recovered.close();
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("repairs a crash-truncated final record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steerloop-journal-tail-"));
    const path = join(directory, "events.jsonl");
    const journal = await EventJournal.open({ path, maxEvents: 10, syncWrites: false });
    await journal.append(event(1));
    await journal.close();
    await appendFile(path, '{"kind":"event"', "utf8");

    const recovered = await EventJournal.open({ path, maxEvents: 10, syncWrites: false });
    expect(recovered.snapshot()).toHaveLength(1);
    await recovered.close();
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("fails closed when a complete journal record is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "steerloop-journal-corrupt-"));
    const path = join(directory, "events.jsonl");
    await writeFile(
      path,
      `${JSON.stringify(event(1))}\n{"kind":"not-an-event"}\n`,
      { mode: 0o600 },
    );

    await expect(
      EventJournal.open({ path, maxEvents: 10, syncWrites: true }),
    ).rejects.toThrow("Corrupt event journal line 2");
  });
});

import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { eventEnvelopeSchema, type EventEnvelope } from "@steerloop/protocol";

export interface EventJournalOptions {
  path: string;
  maxEvents: number;
  syncWrites: boolean;
}

export class EventJournal {
  private handle: FileHandle | undefined;
  private events: EventEnvelope[] = [];
  private persistedLines = 0;
  private tail: Promise<void> = Promise.resolve();

  private constructor(private readonly options: EventJournalOptions) {}

  static async open(options: EventJournalOptions): Promise<EventJournal> {
    const journal = new EventJournal(options);
    await journal.initialize();
    return journal;
  }

  snapshot(): EventEnvelope[] {
    return [...this.events];
  }

  append(event: EventEnvelope): Promise<EventEnvelope[]> {
    return this.enqueue(async () => {
      const handle = this.handle;
      if (handle === undefined) throw new Error("Event journal is closed");
      await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
      if (this.options.syncWrites) await handle.datasync();
      this.persistedLines += 1;
      this.events = [...this.events, event].slice(-this.options.maxEvents);

      if (this.persistedLines >= Math.max(this.options.maxEvents * 2, 2)) {
        await this.compact();
      }
      return this.snapshot();
    });
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      const handle = this.handle;
      this.handle = undefined;
      await handle?.close();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async initialize(): Promise<void> {
    const directory = dirname(this.options.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    let contents = "";
    try {
      contents = await readFile(this.options.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const lines = contents.split("\n");
    const endsWithNewline = contents.length === 0 || contents.endsWith("\n");
    const nonEmptyLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.trim().length > 0);
    const parsed: EventEnvelope[] = [];
    let truncatedTail = false;

    for (const { line, index } of nonEmptyLines) {
      try {
        parsed.push(eventEnvelopeSchema.parse(JSON.parse(line)));
      } catch (error) {
        const isLastPhysicalLine = index === lines.length - 1;
        if (isLastPhysicalLine && !endsWithNewline) {
          truncatedTail = true;
          break;
        }
        throw new Error(`Corrupt event journal line ${index + 1}`, { cause: error });
      }
    }

    this.persistedLines = parsed.length;
    this.events = parsed.slice(-this.options.maxEvents);
    this.handle = await open(this.options.path, "a+", 0o600);
    if (truncatedTail || parsed.length > this.events.length) await this.compact();
  }

  private async compact(): Promise<void> {
    const temporaryPath = `${this.options.path}.${process.pid}.${Date.now()}.tmp`;
    const contents = this.events.map((event) => JSON.stringify(event)).join("\n");
    try {
      await writeFile(temporaryPath, contents.length === 0 ? "" : `${contents}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const temporaryHandle = await open(temporaryPath, "r");
      try {
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }

      await this.handle?.close();
      this.handle = undefined;
      await rename(temporaryPath, this.options.path);

      const directoryHandle = await open(dirname(this.options.path), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      this.handle = await open(this.options.path, "a+", 0o600);
      this.persistedLines = this.events.length;
    } catch (error) {
      if (this.handle === undefined) {
        this.handle = await open(this.options.path, "a+", 0o600);
      }
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error("[relay] could not clean journal temporary file", cleanupError);
        }
      }
      throw error;
    }
  }
}

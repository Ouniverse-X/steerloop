import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type RequestId = string | number;

interface JsonRpcResponse {
  id: RequestId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface JsonRpcServerMessage {
  method: string;
  params?: unknown;
  id?: RequestId;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface CodexAppServerClientOptions {
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
  onNotification?(message: JsonRpcServerMessage): void;
  onServerRequest?(message: JsonRpcServerMessage & { id: RequestId }): void;
  onStderr?(line: string): void;
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private initializationResult: unknown;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  async start(): Promise<void> {
    if (this.child !== undefined) return;
    const child = spawn(
      this.options.command ?? "codex",
      this.options.args ?? ["app-server", "--listen", "stdio://"],
      { env: process.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;

    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => this.handleLine(line));
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => this.options.onStderr?.(line));

    child.once("exit", (code, signal) => {
      this.child = undefined;
      const reason = `Codex App Server exited (${code ?? signal ?? "unknown"})`;
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error(reason));
      }
      this.pending.clear();
    });
    child.once("error", (error) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      this.pending.clear();
    });

    this.initializationResult = await this.request("initialize", {
      clientInfo: {
        name: "steerloop-agent",
        title: "Steerloop Agent",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    this.notify("initialized", {});
  }

  get serverInfo(): unknown {
    return this.initializationResult;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.initializationResult = undefined;
    if (child === undefined) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 1_000).unref();
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? 10_000);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("Codex request failed"));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private write(message: unknown): void {
    if (this.child === undefined || !this.child.stdin.writable) {
      throw new Error("Codex App Server is not running");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;

    const record = message as Record<string, unknown>;
    if ((typeof record.id === "string" || typeof record.id === "number") && !record.method) {
      const response = record as unknown as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (pending === undefined) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timeout);
      if (response.error !== undefined) {
        pending.reject(new Error(response.error.message ?? "Codex request failed"));
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    if (typeof record.method !== "string") return;
    const serverMessage = record as unknown as JsonRpcServerMessage;
    if (typeof serverMessage.id === "string" || typeof serverMessage.id === "number") {
      this.options.onServerRequest?.(
        serverMessage as JsonRpcServerMessage & { id: RequestId },
      );
    } else {
      this.options.onNotification?.(serverMessage);
    }
  }
}

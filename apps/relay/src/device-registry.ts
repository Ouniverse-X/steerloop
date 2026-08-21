import { createHash, randomBytes, timingSafeEqual, webcrypto } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DeviceView {
  id: string;
  name: string;
  hostId: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

interface DeviceRecord extends DeviceView {
  tokenHash: string;
  publicKeyJwk: Record<string, unknown>;
}

interface DeviceFile {
  version: 1;
  devices: DeviceRecord[];
}

interface DeviceRegistryOptions {
  path: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashMatches(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(received, "hex");
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function parseDeviceFile(value: unknown): DeviceFile {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  if (record.version !== 1 || !Array.isArray(record.devices)) {
    throw new Error("Invalid device registry");
  }
  const devices = record.devices.map((entry) => {
    const device = typeof entry === "object" && entry !== null
      ? entry as Record<string, unknown>
      : {};
    if (
      typeof device.id !== "string" ||
      typeof device.name !== "string" ||
      typeof device.hostId !== "string" ||
      typeof device.tokenHash !== "string" ||
      !isP256PublicKey(device.publicKeyJwk) ||
      typeof device.createdAt !== "string" ||
      typeof device.lastSeenAt !== "string" ||
      (device.revokedAt !== undefined && typeof device.revokedAt !== "string")
    ) {
      throw new Error("Invalid device record");
    }
    return device as unknown as DeviceRecord;
  });
  return { version: 1, devices };
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  return Buffer.from(padded, "base64");
}

export function isP256PublicKey(value: unknown): value is Record<string, unknown> {
  const key = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  return (
    key.kty === "EC" &&
    key.crv === "P-256" &&
    typeof key.x === "string" &&
    typeof key.y === "string"
  );
}

export class DeviceRegistry {
  private devices = new Map<string, DeviceRecord>();
  private persistQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly options: DeviceRegistryOptions) {}

  static async open(options: DeviceRegistryOptions): Promise<DeviceRegistry> {
    const registry = new DeviceRegistry(options);
    try {
      const raw = await readFile(options.path, "utf8");
      const parsed = parseDeviceFile(JSON.parse(raw));
      registry.devices = new Map(parsed.devices.map((device) => [device.id, device]));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        await mkdir(dirname(options.path), { recursive: true });
        await registry.enqueuePersist();
      } else {
        throw error;
      }
    }
    return registry;
  }

  list(): DeviceView[] {
    return [...this.devices.values()]
      .map(({ tokenHash: _tokenHash, publicKeyJwk: _publicKeyJwk, ...device }) => device)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  async issue(
    hostId: string,
    name: string,
    publicKeyJwk: Record<string, unknown>,
    now = new Date(),
  ): Promise<{ token: string; device: DeviceView }> {
    if (!isP256PublicKey(publicKeyJwk)) {
      throw new Error("Invalid device public key");
    }
    const token = `slc_${randomBytes(32).toString("hex")}`;
    const timestamp = now.toISOString();
    const device: DeviceRecord = {
      id: randomBytes(12).toString("hex"),
      name,
      hostId,
      tokenHash: hashToken(token),
      publicKeyJwk,
      createdAt: timestamp,
      lastSeenAt: timestamp,
    };
    this.devices.set(device.id, device);
    await this.enqueuePersist();
    const { tokenHash: _tokenHash, publicKeyJwk: _publicKeyJwk, ...view } = device;
    return { token, device: view };
  }

  verify(token: string, now = new Date()): DeviceView | undefined {
    const tokenHash = hashToken(token);
    for (const device of this.devices.values()) {
      if (device.revokedAt !== undefined) continue;
      if (!hashMatches(device.tokenHash, tokenHash)) continue;
      device.lastSeenAt = now.toISOString();
      void this.enqueuePersist().catch((error) => {
        console.error("[relay] failed to persist device registry", error);
      });
      const { tokenHash: _tokenHash, publicKeyJwk: _publicKeyJwk, ...view } = device;
      return view;
    }
    return undefined;
  }

  async revoke(id: string, now = new Date()): Promise<DeviceView | undefined> {
    const device = this.devices.get(id);
    if (device === undefined) return undefined;
    device.revokedAt = now.toISOString();
    await this.enqueuePersist();
    const { tokenHash: _tokenHash, publicKeyJwk: _publicKeyJwk, ...view } = device;
    return view;
  }

  async verifySignature(
    deviceId: string,
    material: string,
    signature: string,
  ): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (device === undefined || device.revokedAt !== undefined) return false;
    try {
      const key = await webcrypto.subtle.importKey(
        "jwk",
        device.publicKeyJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      return await webcrypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        base64UrlToBytes(signature),
        new TextEncoder().encode(material),
      );
    } catch {
      return false;
    }
  }

  private enqueuePersist(): Promise<void> {
    this.persistQueue = this.persistQueue.catch(() => undefined).then(() => this.persist());
    return this.persistQueue;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true });
    const payload: DeviceFile = {
      version: 1,
      devices: [...this.devices.values()],
    };
    const temporaryPath = `${this.options.path}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.options.path);
  }
}

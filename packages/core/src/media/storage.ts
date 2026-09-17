import fs from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Private object storage boundary. Keys are never URLs; access is always mediated by an authorised server route. */
export interface StorageDriver {
  readonly name: string;
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

/** Filesystem driver: useful for local/test only; media root is outside the web root. */
export class FsStorage implements StorageDriver {
  readonly name = "fs";
  constructor(private root: string) {}
  private abs(key: string) {
    const safe = key.replace(/[^A-Za-z0-9_./-]/g, "_").replace(/\.\.+/g, ".");
    const p = path.resolve(this.root, safe);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("invalid storage key");
    return p;
  }
  async put(key: string, bytes: Buffer) { const p = this.abs(key); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, bytes); }
  async get(key: string) { try { return await fs.readFile(this.abs(key)); } catch { return null; } }
  async delete(key: string) { await fs.rm(this.abs(key), { force: true }); }
  async health() { try { await fs.mkdir(this.root, { recursive: true }); const probe = path.join(this.root, ".probe"); await fs.writeFile(probe, "ok"); await fs.rm(probe); return { ok: true, detail: this.root }; } catch (e) { return { ok: false, detail: (e as Error).message }; } }
}

/** S3-compatible object storage driver for production media. */
export class S3Storage implements StorageDriver {
  readonly name = "s3";
  private readonly client: S3Client;
  constructor(private bucket: string, private prefix = "media", options: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean }) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint || undefined,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }
  private key(key: string) {
    const safe = key.replace(/[^A-Za-z0-9_./-]/g, "_").replace(/\.\.+/g, ".").replace(/^\/+/, "");
    return this.prefix ? `${this.prefix.replace(/\/+$/, "")}/${safe}` : safe;
  }
  async put(key: string, bytes: Buffer, mime: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(key), Body: bytes, ContentType: mime, ServerSideEncryption: "AES256" }));
  }
  async get(key: string) {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      if (!response.Body) return null;
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : "";
      if (name === "NoSuchKey" || name === "NotFound") return null;
      throw error;
    }
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) })); }
  async health() {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); return { ok: true, detail: `${this.bucket}/${this.prefix}` }; }
    catch (e) { return { ok: false, detail: (e as Error).message }; }
  }
}

/** Explicit failure driver used only when configuration is incomplete. */
export class UnavailableStorage implements StorageDriver {
  readonly name: string;
  constructor(name: string) { this.name = name; }
  async put(): Promise<void> { throw new Error(`${this.name} storage driver not configured`); }
  async get() { return null; }
  async delete() {}
  async health() { return { ok: false, detail: `${this.name} storage driver not configured` }; }
}

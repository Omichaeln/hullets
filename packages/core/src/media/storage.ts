import fs from "node:fs/promises";
import path from "node:path";

/** Private object storage boundary. Keys are never URLs; access is always mediated by an authorised server route. */
export interface StorageDriver { readonly name: string; put(key: string, bytes: Buffer, mime: string): Promise<void>; get(key: string): Promise<Buffer | null>; delete(key: string): Promise<void>; health(): Promise<{ ok: boolean; detail: string }>; }

/** Filesystem driver: media root outside the web root; keys are sanitised and cannot escape the root. */
export class FsStorage implements StorageDriver {
  readonly name = "fs";
  constructor(private root: string) {}
  private abs(key: string) { const safe = key.replace(/[^A-Za-z0-9_./-]/g, "_").replace(/\.\.+/g, "."); const p = path.resolve(this.root, safe); if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("invalid storage key"); return p; }
  async put(key: string, bytes: Buffer) { const p = this.abs(key); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, bytes); }
  async get(key: string) { try { return await fs.readFile(this.abs(key)); } catch { return null; } }
  async delete(key: string) { await fs.rm(this.abs(key), { force: true }); }
  async health() { try { await fs.mkdir(this.root, { recursive: true }); const probe = path.join(this.root, ".probe"); await fs.writeFile(probe, "ok"); await fs.rm(probe); return { ok: true, detail: this.root }; } catch (e) { return { ok: false, detail: (e as Error).message }; } }
}
/** Placeholder for an S3-compatible driver (hosting decision D-22): same contract; not implemented in this build. */
export class UnavailableStorage implements StorageDriver { readonly name: string; constructor(name: string) { this.name = name; } async put(): Promise<void> { throw new Error(`${this.name} storage driver not implemented`); } async get() { return null; } async delete() {} async health() { return { ok: false, detail: `${this.name} driver not implemented; use fs` }; } }

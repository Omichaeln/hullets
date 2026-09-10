import { eq, and } from "drizzle-orm";
import { schema, type Db } from "@promo/db";
import { newId } from "../util/ids.ts";
import { inspect, normalise, quality, fingerprints } from "./images.ts";
import type { StorageDriver } from "./storage.ts";

const { mediaAssets } = schema;
export type MediaAsset = typeof mediaAssets.$inferSelect;

/** Private media store: validated by bytes, original preserved, normalised working image, hashes and quality signals recorded. */
export class MediaService {
  constructor(private db: Db, private storage: StorageDriver, private retentionDays: number) {}
  async store({ bytes, campaignId }: { bytes: Buffer; campaignId: string }) {
    const info = await inspect(bytes);
    const fp = await fingerprints(bytes);
    const q = await quality(bytes);
    const norm = await normalise(bytes);
    const id = newId("med");
    const key = `${campaignId}/${fp.sha256.slice(0, 2)}/${fp.sha256}.${info.format}`, nkey = `${campaignId}/${fp.sha256.slice(0, 2)}/${fp.sha256}.norm.png`;
    await this.storage.put(key, bytes, info.mime); await this.storage.put(nkey, norm, "image/png");
    await this.db.insert(mediaAssets).values({ id, campaignId, storageKey: key, normalizedKey: nkey, mime: info.mime, bytes: bytes.length, width: info.width, height: info.height, sha256: fp.sha256, ahash: fp.ahash, dhash: fp.dhash, quality: q, status: "stored", expiresAt: new Date(Date.now() + this.retentionDays * 86_400_000).toISOString() });
    return { id, ...fp, info, quality: q, normalised: norm };
  }
  async get(id: string) { const [a] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, id)); return a ?? null; }
  async bytes(a: MediaAsset, { normalised = false } = {}) { if (a.status !== "stored") return null; return this.storage.get(normalised ? (a.normalizedKey ?? a.storageKey) : a.storageKey); }
  /** Retention: remove bytes past expiry, keep the metadata row (status purged) so references stay resolvable. */
  async purgeExpired(limit = 200) {
    const rows = await this.db.select().from(mediaAssets).where(and(eq(mediaAssets.status, "stored"))).limit(5000);
    let n = 0; const now = Date.now();
    for (const a of rows) { if (!a.expiresAt || Date.parse(a.expiresAt) > now) continue; await this.storage.delete(a.storageKey); if (a.normalizedKey) await this.storage.delete(a.normalizedKey); await this.db.update(mediaAssets).set({ status: "purged" }).where(eq(mediaAssets.id, a.id)); if (++n >= limit) break; }
    return n;
  }
}

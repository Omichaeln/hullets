import crypto from "node:crypto";

export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
export const hmac = (key: string | Buffer, s: string) => crypto.createHmac("sha256", key).update(s).digest("hex");
export const randomHex = (bytes: number) => crypto.randomBytes(bytes).toString("hex");
export const timingEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Password hashing: scrypt (N=2^15) with per-user salt; format scrypt$N$salt$hash. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16); const N = 32768;
  const key = crypto.scryptSync(password, salt, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, salt, hash] = stored.split("$"); if (alg !== "scrypt") return false;
  const key = crypto.scryptSync(password, Buffer.from(salt, "base64url"), 32, { N: Number(n), r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const h = Buffer.from(hash, "base64url"); return key.length === h.length && crypto.timingSafeEqual(key, h);
}

/** Field-level encryption (AES-256-GCM) for identity numbers and MFA secrets. Key derived from the configured key material. */
export class FieldCipher {
  private key: Buffer;
  constructor(keyMaterial: string, purpose: string) { this.key = crypto.hkdfSync("sha256", keyMaterial, "promo-engine", purpose, 32) as unknown as Buffer; this.key = Buffer.from(this.key); }
  encrypt(plain: string): string { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", this.key, iv); const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]); return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`; }
  decrypt(blob: string): string { const [v, iv, tag, enc] = blob.split("."); if (v !== "v1") throw new Error("unknown cipher version"); const d = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url")); d.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8"); }
  /** Keyed fingerprint for equality (never a plain, guessable hash). */
  fingerprint(normalised: string): string { return crypto.createHmac("sha256", this.key).update(normalised).digest("hex"); }
}

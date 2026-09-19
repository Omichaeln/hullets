import crypto from "node:crypto";

export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
export const hmac = (key: string | Buffer, s: string) => crypto.createHmac("sha256", key).update(s).digest("hex");
export const randomHex = (bytes: number) => crypto.randomBytes(bytes).toString("hex");
export const timingEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/**
 * Password hashing: scrypt (N=2^15) with per-user salt; format scrypt$N$salt$hash.
 *
 * Deliberately ASYNC. scryptSync at these parameters costs ~100 ms of CPU and
 * 32 MB, and it blocks the event loop for the whole of it — so a handful of
 * login attempts per second starve every other request in the process, which on
 * the default embedded-worker topology includes receipt intake. The callback
 * form runs on the libuv threadpool and leaves the loop free.
 */
const SCRYPT_PARAMS = { r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const scrypt = (password: string, salt: Buffer, N: number) =>
  new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 32, { N, ...SCRYPT_PARAMS }, (err, key) => (err ? reject(err) : resolve(key as Buffer))));

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16); const N = 32768;
  const key = await scrypt(password, salt, N);
  return `scrypt$${N}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, salt, hash] = String(stored ?? "").split("$"); if (alg !== "scrypt") return false;
  const N = Number(n); if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || N > 1 << 20) return false;
  const key = await scrypt(password, Buffer.from(salt, "base64url"), N);
  const h = Buffer.from(hash, "base64url"); return key.length === h.length && crypto.timingSafeEqual(key, h);
}
/**
 * A throwaway hash whose cost matches a real verification, used on the
 * unknown-account path. Without it, a miss returns in microseconds and a hit
 * takes ~100 ms, which distinguishes real staff addresses from invented ones by
 * timing alone.
 */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordTime(password: string): Promise<false> {
  dummyHash ??= hashPassword(crypto.randomBytes(32).toString("hex"));
  await verifyPassword(password, await dummyHash);
  return false;
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

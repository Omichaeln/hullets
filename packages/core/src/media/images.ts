import sharp, { type Metadata } from "sharp";
import { sha256 } from "../util/crypto.ts";

export const ALLOWED = new Set(["jpeg", "png", "webp", "heif", "tiff"]);
export const MAX_BYTES = 12 * 1024 * 1024;
export const MAX_PIXELS = 36_000_000;
export type ImageInfo = { format: string; mime: string; width: number; height: number };
export class MediaRejected extends Error { code = "MEDIA_REJECTED"; constructor(m: string, public why: string) { super(m); } }

/** Type is decided from bytes, never from the provider's declared MIME. */
export async function inspect(bytes: Buffer): Promise<ImageInfo> {
  if (!bytes?.length) throw new MediaRejected("empty upload", "empty");
  if (bytes.length > MAX_BYTES) throw new MediaRejected("image larger than 12 MB", "too_large");
  let m: Metadata;
  try { m = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata(); } catch { throw new MediaRejected("unsupported or malformed image", "bad_type"); }
  if (!m.format || !ALLOWED.has(m.format)) throw new MediaRejected(`unsupported format ${m.format ?? "unknown"}`, "bad_type");
  if (!m.width || !m.height || m.width * m.height > MAX_PIXELS) throw new MediaRejected("image dimensions too large", "too_large");
  if (m.width < 120 || m.height < 120) throw new MediaRejected("image too small to be a receipt", "too_small");
  return { format: m.format, mime: ({ jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heif: "image/heic", tiff: "image/tiff" } as Record<string, string>)[m.format], width: m.width, height: m.height };
}
/** Working copy for OCR: EXIF-rotated, greyscale, contrast-stretched, width-bounded PNG. The original is kept untouched. */
export async function normalise(bytes: Buffer, width = 1600) { return sharp(bytes, { limitInputPixels: MAX_PIXELS }).rotate().grayscale().normalise().resize({ width, withoutEnlargement: false }).png().toBuffer(); }
async function raster(bytes: Buffer, w: number, h: number) { const { data } = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).rotate().grayscale().resize(w, h, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true }); return data; }
export function aHash(g: Uint8Array) { let mean = 0; for (let i = 0; i < 64; i++) mean += g[i]; mean /= 64; let h = 0n; for (let i = 0; i < 64; i++) if (g[i] >= mean) h |= 1n << BigInt(63 - i); return h.toString(16).padStart(16, "0"); }
export function dHash(g: Uint8Array) { let h = 0n, bit = 63; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { if (g[y * 9 + x] < g[y * 9 + x + 1]) h |= 1n << BigInt(bit); bit--; } return h.toString(16).padStart(16, "0"); }
export function hamming(a?: string | null, b?: string | null) { if (!a || !b) return 64; let x = BigInt("0x" + a) ^ BigInt("0x" + b), d = 0; while (x) { d += Number(x & 1n); x >>= 1n; } return d; }
export type Quality = { brightness: number; contrast: number; sharpness: number; tooDark: boolean; tooBright: boolean; lowContrast: boolean; blurry: boolean };
export async function quality(bytes: Buffer): Promise<Quality> {
  const w = 256, h = 256, g = await raster(bytes, w, h); let s = 0, s2 = 0, l = 0, l2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x, v = g[i]; s += v; s2 += v * v; const lap = 4 * v - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]; l += lap; l2 += lap * lap; n++; }
  const mean = s / n, variance = Math.max(0, s2 / n - mean * mean), lm = l / n, lv = Math.max(0, l2 / n - lm * lm);
  return { brightness: Math.round(mean), contrast: Math.round(Math.sqrt(variance)), sharpness: Math.round(lv), tooDark: mean < 45, tooBright: mean > 238, lowContrast: Math.sqrt(variance) < 16, blurry: lv < 50 };
}
export async function fingerprints(bytes: Buffer) { const out = { sha256: sha256(bytes), ahash: null as string | null, dhash: null as string | null }; try { out.ahash = aHash(await raster(bytes, 8, 8)); out.dhash = dHash(await raster(bytes, 9, 8)); } catch { /* unreadable: hashes stay null */ } return out; }
export async function rotatePng(png: Buffer, deg: number) { return sharp(png).rotate(deg).png().toBuffer(); }

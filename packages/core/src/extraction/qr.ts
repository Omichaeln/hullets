import { createRequire } from "node:module";
import { BinaryBitmap, BarcodeFormat, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library";
import sharp from "sharp";
import { sha256 } from "../util/crypto.ts";

const require = createRequire(import.meta.url);
export const DECODER_VERSION = `zxing-js@${require("@zxing/library/package.json").version as string}`;
const jsQR = require("jsqr") as (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }) => { data: string } | null;
const MAX_SCAN_PIXELS = 16_000_000;
const DEFAULT_ALLOWED_FORMATS = new Set([
  BarcodeFormat.QR_CODE,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
]);
type SharpPipeline = ReturnType<typeof sharp>;

export type QrDecodedCode = { format: string; text: string; rawSha256: string };

/**
 * Read QR and retail barcodes off a receipt photograph.
 *
 * This module decodes and nothing else. It used to also FETCH whatever URL a
 * decoded QR contained and merge the response into the receipt's facts, with
 * an empty host allowlist meaning "any public host" — so a printed code could
 * supply the merchant, date, receipt number and line items that decided whether
 * an entry was awarded, and a flag set by that same fetch suppressed the
 * low-confidence review trigger. A code found on a receipt is now only ever a
 * set of identifiers; what is done with them lives in ../fiscal, which looks
 * them up against a configured, allowlisted revenue-authority endpoint and
 * treats the answer — not the code — as evidence.
 *
 * Decoding is bounded: a capped pixel count, four crops biased towards the
 * bottom of a receipt where fiscal codes are printed, and four normalisations.
 */
export async function decodeReceiptCodes(bytes: Buffer): Promise<QrDecodedCode[]> {
  const rotated = sharp(bytes, { limitInputPixels: MAX_SCAN_PIXELS }).rotate();
  const meta = await rotated.metadata();
  const width = meta.width ?? 0, height = meta.height ?? 0;
  if (!width || !height || width * height > MAX_SCAN_PIXELS) return [];
  const crops = [{ top: 0, height }, { top: Math.floor(height * 0.25), height: Math.ceil(height * 0.75) }, { top: Math.floor(height * 0.5), height: Math.ceil(height * 0.5) }, { top: Math.floor(height * 0.65), height: Math.ceil(height * 0.35) }]
    .map((x) => ({ left: 0, top: Math.max(0, x.top), width, height: Math.min(height - Math.max(0, x.top), x.height) }))
    .filter((x) => x.height >= 80);
  const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, Array.from(DEFAULT_ALLOWED_FORMATS)], [DecodeHintType.TRY_HARDER, true]]);
  const variants = [
    (x: SharpPipeline) => x.ensureAlpha(),
    (x: SharpPipeline) => x.grayscale(),
    (x: SharpPipeline) => x.grayscale().normalise(),
    (x: SharpPipeline) => x.grayscale().normalise().threshold(160),
  ];
  for (const crop of crops) for (const variant of variants) {
    try {
      const { data, info } = await variant(rotated.clone().extract(crop).resize({ width: 2200 })).raw().toBuffer({ resolveWithObject: true });
      let source: RGBLuminanceSource;
      if (info.channels === 1) source = new RGBLuminanceSource(new Uint8ClampedArray(data), info.width, info.height);
      else { const pixels = new Int32Array(info.width * info.height); for (let i = 0, p = 0; i < pixels.length; i++, p += info.channels) pixels[i] = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2]; source = new RGBLuminanceSource(pixels, info.width, info.height); }
      try {
        const result = new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(source)), hints);
        const text = result.getText().trim();
        if (text) return [{ format: BarcodeFormat[result.getBarcodeFormat()] ?? String(result.getBarcodeFormat()), text: text.slice(0, 2048), rawSha256: sha256(text) }];
      } catch { /* jsQR gets a turn on the RGBA variants below */ }
      if (info.channels === 4) {
        const result = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: "attemptBoth" });
        if (result?.data?.trim()) { const text = result.data.trim(); return [{ format: "QR_CODE", text: text.slice(0, 2048), rawSha256: sha256(text) }]; }
      }
    } catch { /* try the next bounded crop/normalisation */ }
  }
  return [];
}

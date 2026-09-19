/**
 * Regenerate the fiscal QR test fixture.
 *
 * The encoded value is a ZIMRA-shaped verification URL: a host plus the packed
 * tail of device id, fiscal day, receipt global number and verification code,
 * at the widths in FISCAL_QR_LAYOUT. Fictional device and codes throughout.
 *
 *   npx tsx tools/gen-qr-fixture.ts
 */
import fs from "node:fs/promises";
import sharp from "sharp";
import { QRCodeWriter, EncodeHintType, BarcodeFormat } from "@zxing/library";

export const FIXTURE_VALUE = "https://fdms.example.test/#0000012345001800000000771A2B3C4D5E6F7A8B";
const OUT = "tests/fixtures/zimra-fiscal-qr.png";

export async function renderQr(value: string, out: string, { size = 600, margin = 2 } = {}) {
  const hints = new Map<EncodeHintType, unknown>([[EncodeHintType.MARGIN, margin]]);
  const bits = new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, size, size, hints as never);
  const w = bits.getWidth(), h = bits.getHeight();
  const raw = Buffer.alloc(w * h, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bits.get(x, y)) raw[y * w + x] = 0;
  await sharp(raw, { raw: { width: w, height: h, channels: 1 } }).png().toFile(out);
  return { size: w };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await fs.mkdir("tests/fixtures", { recursive: true });
  const { size } = await renderQr(FIXTURE_VALUE, OUT);
  console.log(`wrote ${OUT} (${size}x${size}) encoding ${FIXTURE_VALUE}`);
}

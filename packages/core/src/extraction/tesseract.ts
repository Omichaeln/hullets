import path from "node:path";
import { createRequire } from "node:module";
import type { Extractor, Facts, ExtractionContext } from "./types.ts";
import { ExtractorUnavailable, emptyFacts } from "./types.ts";
import { parseReceiptText } from "./parser.ts";
import { rotatePng } from "../media/images.ts";
const require = createRequire(import.meta.url);

/** Real, offline OCR (tesseract.js WASM, English model bundled from npm). Reads pixels through the normal pipeline; no fixture knowledge. One worker, per-call timeout, bounded orientation retry. */
export class TesseractExtractor implements Extractor {
  readonly name = "tesseract"; readonly mode = "real" as const;
  private worker: import("tesseract.js").Worker | null = null; private version = "?"; private chain: Promise<unknown> = Promise.resolve();
  constructor(private timeoutMs = 45_000) {}
  private async ensure() {
    if (this.worker) return this.worker;
    const { createWorker } = await import("tesseract.js"); this.version = require("tesseract.js/package.json").version as string;
    const langPath = path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
    this.worker = await createWorker("eng", 1, { langPath, cachePath: langPath, gzip: true, logger: () => {} });
    await this.worker.setParameters({ preserve_interword_spaces: "1" });
    return this.worker;
  }
  private recognise(png: Buffer) {
    const run = this.chain.then(async () => { const w = await this.ensure(); let t: NodeJS.Timeout | undefined; const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("ocr timeout")), this.timeoutMs); }); try { return await Promise.race([w.recognize(png), timeout]); } finally { clearTimeout(t); } });
    this.chain = run.catch(() => {}); return run;
  }
  async ocr(png: Buffer) { const t0 = Date.now(); const r = await this.recognise(png); return { text: r.data.text ?? "", confidence: Number.isFinite(r.data.confidence) ? r.data.confidence / 100 : null, ms: Date.now() - t0 }; }
  async extract({ normalised, context }: { original: Buffer; normalised: Buffer; mime: string; context: ExtractionContext }): Promise<Facts> {
    const t0 = Date.now(); const model = `tesseract.js@${this.version}/eng-best-int`;
    try {
      let { text, confidence, ms } = await this.ocr(normalised); let rotation = 0;
      let facts = parseReceiptText(text, context, { provider: this.name, model, promptVersion: "parser/1", confidence });
      // sideways photos carry no EXIF orientation: retry two rotations when the upright pass does not read as a receipt and was cheap
      if (facts.document.kind !== "receipt" && ms < 9000) for (const deg of [90, 270]) { const alt = await this.ocr(await rotatePng(normalised, deg)); const f2 = parseReceiptText(alt.text, context, { provider: this.name, model, promptVersion: "parser/1", confidence: alt.confidence }); if (f2.document.score > facts.document.score) { facts = f2; text = alt.text; confidence = alt.confidence; rotation = deg; } if (facts.document.kind === "receipt") break; }
      return { ...facts, latencyMs: Date.now() - t0, raw: { engine: "tesseract.js", confidence, rotation, chars: text.length } };
    } catch (e) { throw new ExtractorUnavailable(`ocr failed: ${(e as Error).message}`, "OCR_UNAVAILABLE"); }
  }
  async health() { try { await this.ensure(); return { provider: this.name, mode: "real", ok: true, model: `tesseract.js@${this.version}` }; } catch (e) { return { provider: this.name, mode: "real", ok: false, error: (e as Error).message }; } }
  async close() { try { await this.worker?.terminate(); } catch { /* ignore */ } this.worker = null; }
  static empty = emptyFacts;
}

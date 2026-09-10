import type { Config } from "../config.ts";
import type { Extractor, Facts, ExtractionContext } from "./types.ts";
import { AnthropicExtractor } from "./anthropic.ts";
import { TesseractExtractor } from "./tesseract.ts";
import { SimulatorExtractor } from "./simulator.ts";
export * from "./types.ts";
export { AnthropicExtractor, TesseractExtractor, SimulatorExtractor };
export { embedReceiptText } from "./simulator.ts";
export { parseReceiptText } from "./parser.ts";

/** Vision model for structure, offline OCR as an independent witness: disagreement on identity fields becomes a review warning. */
export class CrossCheckedExtractor implements Extractor {
  readonly name = "anthropic-vision+tesseract";
  constructor(private primary: AnthropicExtractor, private witness: TesseractExtractor) {}
  get mode() { return this.primary.mode; }
  async extract(input: { original: Buffer; normalised: Buffer; mime: string; context: ExtractionContext }): Promise<Facts> {
    const [facts, witness] = await Promise.all([this.primary.extract(input), this.witness.extract(input).catch(() => null)]);
    if (!witness) return { ...facts, provider: this.name, quality: { ...facts.quality, warnings: [...facts.quality.warnings, "witness_unavailable"] } };
    const warnings = [...facts.quality.warnings];
    if (facts.transaction.receiptNo && witness.transaction.receiptNo && facts.transaction.receiptNo !== witness.transaction.receiptNo) warnings.push("witness_receipt_no_disagreement");
    if (facts.transaction.date && witness.transaction.date && facts.transaction.date !== witness.transaction.date) warnings.push("witness_date_disagreement");
    return { ...facts, provider: this.name, quality: { ...facts.quality, warnings, confidence: witness.quality.confidence }, raw: { ...(facts.raw ?? {}), witness: witness.raw } };
  }
  async health() { const p = await this.primary.health(); const w = await this.witness.health(); return { provider: this.name, mode: p.mode, ok: p.ok && w.ok, model: `${p.model} + ${w.model}`, note: p.note }; }
  async close() { await this.witness.close(); }
}
export function createExtractor(cfg: Config): Extractor {
  switch (cfg.EXTRACTOR) {
    case "anthropic": return new AnthropicExtractor({ apiKey: cfg.ANTHROPIC_API_KEY, model: cfg.ANTHROPIC_MODEL, baseURL: cfg.ANTHROPIC_BASE_URL, timeoutMs: cfg.EXTRACTION_TIMEOUT_MS });
    case "anthropic+tesseract": return new CrossCheckedExtractor(new AnthropicExtractor({ apiKey: cfg.ANTHROPIC_API_KEY, model: cfg.ANTHROPIC_MODEL, baseURL: cfg.ANTHROPIC_BASE_URL, timeoutMs: cfg.EXTRACTION_TIMEOUT_MS }), new TesseractExtractor(cfg.EXTRACTION_TIMEOUT_MS));
    case "simulator": if (!["local", "test"].includes(cfg.ENVIRONMENT)) throw new Error("simulator extractor is only allowed in local/test"); return new SimulatorExtractor();
    default: return new TesseractExtractor(cfg.EXTRACTION_TIMEOUT_MS);
  }
}

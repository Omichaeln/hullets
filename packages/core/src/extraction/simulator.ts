import type { Extractor, Facts, ExtractionContext } from "./types.ts";
import { parseReceiptText } from "./parser.ts";
/** TEST ONLY: reads a text block embedded in the upload bytes instead of pixels, so rules/ledger/draw tests run without OCR latency. Refused outside local/test; labelled everywhere. */
export class SimulatorExtractor implements Extractor {
  readonly name = "simulator"; readonly mode = "simulated" as const;
  /** TEST ONLY: throw this once on the next extraction (outage rehearsal). */
  failNext: Error | null = null;
  async extract({ original, context }: { original: Buffer; normalised: Buffer; mime: string; context: ExtractionContext }): Promise<Facts> {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    const m = original.toString("latin1").match(/SIMTEXT:([A-Za-z0-9+/=]+):/); const text = m ? Buffer.from(m[1], "base64").toString("utf8") : "";
    return { ...parseReceiptText(text, context, { provider: this.name, model: "simulator/1", promptVersion: "parser/1" }), raw: { simulated: true } };
  }
  async health() { return { provider: this.name, mode: "simulated", ok: true, note: "TEST ONLY — does not read pixels" }; }
}
export const embedReceiptText = (text: string) => Buffer.from(`SIMTEXT:${Buffer.from(text, "utf8").toString("base64")}:`, "latin1");

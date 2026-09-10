import type { WhatsAppTransport, OutboundPayload } from "./transport.ts";
import { SendError } from "./transport.ts";
import type { NormalisedEvent } from "../ops/queue.ts";
/** TEST ONLY transport: records sends in memory; inbound arrives from the console simulator or a signed test webhook. Never evidence of WhatsApp integration; refused in production. */
export class SimulatorTransport implements WhatsAppTransport {
  readonly provider = "simulator"; readonly mode = "simulated" as const; readonly requiresTemplateOutsideWindow = false;
  sent: Array<{ id: string; to: string; kind: string; body?: string; at: string }> = []; failNext: { message: string; code?: string; permanent?: boolean; unknownOutcome?: boolean } | null = null; private n = 0;
  parseInbound(payload: unknown): NormalisedEvent[] { const p = payload as { events?: NormalisedEvent[] }; return (p?.events ?? []).map((e) => ({ ...e, provider: "simulator" })); }
  async send(m: OutboundPayload) { if (this.failNext) { const f = this.failNext; this.failNext = null; throw new SendError(f.message, f.code ?? "SIMULATED", !!f.permanent, !!f.unknownOutcome); } const id = `sim.${++this.n}.${Date.now()}`; this.sent.push({ id, to: m.to, kind: m.kind, body: m.body, at: new Date().toISOString() }); if (this.sent.length > 500) this.sent.shift(); return { providerMessageId: id }; }
  async downloadMedia(): Promise<Buffer> { throw Object.assign(new Error("simulator has no media store; media must be inline"), { permanent: true }); }
  health() { return { ok: true, provider: this.provider, mode: "simulated", note: "TEST ONLY — not a WhatsApp connection" }; }
}

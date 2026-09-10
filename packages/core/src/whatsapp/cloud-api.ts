import crypto from "node:crypto";
import type { WhatsAppTransport, OutboundPayload } from "./transport.ts";
import { SendError } from "./transport.ts";
import type { NormalisedEvent } from "../ops/queue.ts";
import { normalisePhone } from "../util/phone.ts";

/**
 * Meta WhatsApp Business Platform (Cloud API) adapter: verify handshake,
 * X-Hub-Signature-256 validation, event normalisation (messages and delivery
 * statuses are distinct events), two-step media download restricted to Meta
 * hosts, template/text/interactive sends, timeouts with unknown-outcome
 * detection. Verified against a live account only when the client's assets
 * are connected (docs/integrations/whatsapp.md).
 */
export class CloudApiTransport implements WhatsAppTransport {
  readonly provider = "whatsapp-cloud-api"; readonly mode = "configured" as const; readonly requiresTemplateOutsideWindow = true;
  private lastSuccessAt: string | null = null; private lastError: string | null = null;
  constructor(private o: { graphVersion: string; phoneNumberId: string; accessToken: string; appSecret: string; verifyToken: string; defaultCountryCode: string; timeoutMs?: number; fetchImpl?: typeof fetch }) { if (!o.accessToken) throw new Error("META_ACCESS_TOKEN required"); }
  private get base() { return `https://graph.facebook.com/${this.o.graphVersion}`; }
  verifyHandshake(p: URLSearchParams) { const token = p.get("hub.verify_token") ?? ""; const ok = p.get("hub.mode") === "subscribe" && token.length === this.o.verifyToken.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.o.verifyToken)); return ok ? { status: 200, body: p.get("hub.challenge") ?? "" } : { status: 403, body: "verification failed" }; }
  validateSignature(headers: Record<string, string | string[] | undefined>, raw: Buffer) { const sig = String(headers["x-hub-signature-256"] ?? "").replace("sha256=", ""); if (!/^[0-9a-f]{64}$/.test(sig)) return false; const calc = crypto.createHmac("sha256", this.o.appSecret).update(raw).digest("hex"); return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(calc, "hex")); }
  parseInbound(payload: unknown): NormalisedEvent[] {
    const out: NormalisedEvent[] = []; const p = payload as { entry?: Array<{ changes?: Array<{ value?: Record<string, unknown> }> }> };
    for (const entry of p?.entry ?? []) for (const ch of entry.changes ?? []) {
      const v = (ch.value ?? {}) as { metadata?: { phone_number_id?: string }; messages?: Array<Record<string, unknown>>; statuses?: Array<Record<string, unknown>> };
      const account = v.metadata?.phone_number_id ?? this.o.phoneNumberId;
      for (const m of v.messages ?? []) {
        const from = normalisePhone(String(m.from ?? ""), this.o.defaultCountryCode); const t = String(m.type ?? "unknown"); const ts = new Date(Number(m.timestamp ?? 0) * 1000 || Date.now()).toISOString();
        const base = { provider: this.provider, providerAccount: account, providerMessageId: String(m.id), channelUid: from, timestamp: ts, raw: { type: t } };
        if (t === "text") out.push({ ...base, kind: "message.text", text: String((m.text as { body?: string })?.body ?? "") });
        else if (t === "image") out.push({ ...base, kind: "message.image", mediaId: String((m.image as { id?: string })?.id ?? ""), mime: (m.image as { mime_type?: string })?.mime_type ?? null, text: String((m.image as { caption?: string })?.caption ?? "") });
        else if (t === "document") out.push({ ...base, kind: "message.document", mediaId: String((m.document as { id?: string })?.id ?? ""), mime: (m.document as { mime_type?: string })?.mime_type ?? null });
        else if (t === "interactive") { const i = m.interactive as { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } }; out.push({ ...base, kind: "message.text", text: i?.button_reply?.id ?? i?.list_reply?.id ?? i?.button_reply?.title ?? "" }); }
        else if (t === "button") out.push({ ...base, kind: "message.text", text: String((m.button as { payload?: string; text?: string })?.payload ?? (m.button as { text?: string })?.text ?? "") });
        else out.push({ ...base, kind: "message.unsupported" });
      }
      for (const s of v.statuses ?? []) out.push({ provider: this.provider, providerAccount: account, providerMessageId: String(s.id), kind: "delivery.status", status: String(s.status), channelUid: normalisePhone(String(s.recipient_id ?? ""), this.o.defaultCountryCode), errorCode: (s.errors as Array<{ code?: number }>)?.[0]?.code?.toString() ?? null, timestamp: new Date(Number(s.timestamp ?? 0) * 1000 || Date.now()).toISOString() });
    }
    return out;
  }
  private async call(url: string, init: RequestInit & { method?: string }) { const f = this.o.fetchImpl ?? fetch; const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 15_000); try { return await f(url, { ...init, signal: ctrl.signal, headers: { Authorization: `Bearer ${this.o.accessToken}`, ...(init.headers as Record<string, string> ?? {}) } }); } catch (e) { const x = e as Error; throw new SendError(x.name === "AbortError" ? "cloud api timeout" : x.message, "NETWORK", false, x.name === "AbortError" && init.method === "POST"); } finally { clearTimeout(t); } }
  async send(m: OutboundPayload) {
    const to = normalisePhone(m.to, this.o.defaultCountryCode); if (!to) throw new SendError("invalid recipient", "INVALID_RECIPIENT", true);
    const body: Record<string, unknown> = { messaging_product: "whatsapp", recipient_type: "individual", to };
    if (m.kind === "text") { body.type = "text"; body.text = { body: String(m.body ?? "").slice(0, 4096), preview_url: false }; } else if (m.kind === "template") { body.type = "template"; body.template = m.template; } else { body.type = "interactive"; body.interactive = m.interactive; }
    const res = await this.call(`${this.base}/${this.o.phoneNumberId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { code?: number; message?: string } };
    if (!res.ok) { this.lastError = `${new Date().toISOString()} ${res.status} ${j.error?.message ?? ""}`; throw new SendError(`cloud api ${res.status}: ${j.error?.message ?? "send failed"}`, j.error?.code ? `META_${j.error.code}` : `HTTP_${res.status}`, res.status >= 400 && res.status < 500 && ![429, 408].includes(res.status)); }
    this.lastSuccessAt = new Date().toISOString(); return { providerMessageId: j.messages?.[0]?.id ?? null };
  }
  async downloadMedia(mediaId: string) {
    const r = await this.call(`${this.base}/${encodeURIComponent(mediaId)}`, { method: "GET" }); if (!r.ok) throw Object.assign(new Error(`media resolve failed ${r.status}`), { permanent: [400, 404].includes(r.status) });
    const j = (await r.json().catch(() => ({}))) as { url?: string };
    if (!j.url || !/^https:\/\/(lookaside\.fbsbx\.com|scontent[.-][a-z0-9.-]*fbcdn\.net|[a-z0-9.-]*whatsapp\.net)\//i.test(j.url)) throw Object.assign(new Error("media url missing or not a Meta host"), { permanent: true });
    const dl = await this.call(j.url, { method: "GET" }); if (!dl.ok) throw Object.assign(new Error(`media download failed ${dl.status}`), { permanent: [404, 410].includes(dl.status) });
    if (Number(dl.headers.get("content-length") ?? 0) > 12 * 1024 * 1024) throw Object.assign(new Error("media too large"), { permanent: true });
    return Buffer.from(await dl.arrayBuffer());
  }
  health() { return { ok: true, provider: this.provider, mode: "configured", note: "credentials present; live delivery is verified only by a recorded send/receive round-trip", lastSuccessAt: this.lastSuccessAt, lastError: this.lastError }; }
}

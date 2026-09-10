import type { NormalisedEvent } from "../ops/queue.ts";
export type OutboundPayload = { kind: "text" | "template" | "interactive"; to: string; body?: string; template?: Record<string, unknown>; interactive?: Record<string, unknown> };
export class SendError extends Error { constructor(m: string, public code: string, public permanent = false, public unknownOutcome = false) { super(m); } }
/** Channel adapter contract: provider authentication, event normalisation, media retrieval, delivery. */
export interface WhatsAppTransport {
  readonly provider: string; readonly mode: "configured" | "simulated";
  readonly requiresTemplateOutsideWindow: boolean;
  verifyHandshake?(params: URLSearchParams): { status: number; body: string };
  validateSignature?(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean;
  parseInbound(payload: unknown): NormalisedEvent[];
  send(m: OutboundPayload): Promise<{ providerMessageId: string | null }>;
  downloadMedia(mediaId: string): Promise<Buffer>;
  health(): { ok: boolean; provider: string; mode: string; note?: string; lastSuccessAt?: string | null; lastError?: string | null };
}

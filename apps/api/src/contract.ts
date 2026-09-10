import { z } from "zod";
import { appRouter } from "./router.ts";
/** Machine-readable API contract generated from the tRPC router: procedure, type, input JSON schema, required permission (from the guard). Served at /api/contract.json and written to docs/api/contract.json. */
export function contractDocument() {
  const procedures: Array<{ path: string; type: string; access: string; input: unknown }> = [];
  const all = (appRouter as unknown as { _def: { procedures: Record<string, { _def: { type?: string; inputs?: unknown[]; meta?: { permission?: string; session?: boolean; public?: boolean } } }> } })._def.procedures;
  for (const [path, proc] of Object.entries(all)) {
    if (path.startsWith("_") || path.includes("._")) continue;
    const def = proc._def; const input = def.inputs?.[0]; let schema: unknown = null;
    try { schema = input ? z.toJSONSchema(input as z.ZodType, { unrepresentable: "any" }) : null; } catch { schema = "unrepresentable"; }
    procedures.push({ path, type: def.type ?? "unknown", access: def.meta?.permission ?? (def.meta?.public ? "public" : "session"), input: schema });
  }
  procedures.sort((a, b) => a.path.localeCompare(b.path));
  return { contract: "hullets-api/1", transport: "tRPC 11 over HTTP (POST /trpc/<path> for mutations, GET for queries; batch supported)", auth: "Authorization: Bearer <session token> from auth.login / auth.verifyMfa", errors: "tRPC error envelope with data.domainCode (VALIDATION, NOT_FOUND, CONFLICT, FORBIDDEN, UNAUTHORIZED, SOD, BLOCKED, INTEGRITY, APPROVAL_REQUIRED, IDENTITY_INCOMPLETE, RATE_LIMITED); unknown input fields are stripped", rest: [{ path: "GET /webhooks/whatsapp", note: "Meta verify handshake" }, { path: "POST /webhooks/whatsapp", note: "signed provider events; durable-then-ack; 503 asks the provider to retry" }, { path: "GET /api/media/:submissionId?v=normalised", note: "bearer; submission.media permission; audited" }, { path: "GET /api/export/:scope.csv", note: "bearer; report.export; formula-safe; watermarked" }, { path: "GET /api/draws/:drawId/bundle.json", note: "bearer; draw.bundle; independent verifier input" }, { path: "GET /health/live | /health/ready", note: "liveness / readiness" }], procedures };
}

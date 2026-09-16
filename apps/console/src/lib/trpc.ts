import type { inferRouterOutputs } from "@trpc/server";
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import type { AppRouter } from "../../../api/src/router.ts";
export const trpc = createTRPCReact<AppRouter>();
export type RouterOutputs = inferRouterOutputs<AppRouter>;
const KEY = "hullets.token";
export const session = {
  get token() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(t: string | null) { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* storage unavailable: session lasts for the page only */ } },
};
export function makeClient() { return trpc.createClient({ links: [httpBatchLink({ url: "/trpc", headers: () => { const t = session.token; return t ? { authorization: `Bearer ${t}` } : {}; } })] }); }
/** Authenticated fetch for the REST surfaces (media, exports, bundles). */
export async function authFetch(path: string, init: RequestInit = {}) { const t = session.token; return fetch(path, { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), ...(t ? { authorization: `Bearer ${t}` } : {}) } }); }
export async function downloadAuth(path: string, filename: string) { const r = await authFetch(path); if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`.trim()); const blob = await r.blob(); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); }
export function errorMessage(e: unknown): string { const x = e as { message?: string; data?: { domainCode?: string; blockers?: Array<{ code: string }>; failures?: Array<{ code: string }> } }; const extra = x?.data?.blockers?.map((b) => b.code).join(", ") ?? x?.data?.failures?.map((f) => f.code).join(", "); return `${x?.message ?? String(e)}${extra ? ` (${extra})` : ""}`; }

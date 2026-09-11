import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "../../../api/src/router.ts";
import { session } from "./trpc.ts";
/**
 * Client-side failures (render crashes, unhandled rejections, script errors) are
 * reported to the API's error log so they sit next to server-side failures.
 * Best effort and bounded: signed-in sessions only, at most a handful per page
 * load, each distinct message once, never anything but the message and the URL.
 */
const seen = new Set<string>(); let budget = 5;
const client = createTRPCClient<AppRouter>({ links: [httpLink({ url: "/trpc", headers: () => { const t = session.token; return t ? { authorization: `Bearer ${t}` } : {}; } })] });
export function reportClientError(kind: string, message: unknown) {
  const m = String((message as { message?: string })?.message ?? message ?? "error").slice(0, 500); if (!session.token || budget <= 0 || seen.has(m) || /Failed to fetch|NetworkError|Load failed/i.test(m)) return;
  seen.add(m); budget--;
  client.ops.reportClientError.mutate({ kind, message: m, url: (location.pathname + location.search).slice(0, 300) }).catch(() => undefined);
}
let installed = false;
export function installErrorReporting() {
  if (installed) return; installed = true;
  addEventListener("error", (e) => reportClientError("script_error", e.error ?? e.message));
  addEventListener("unhandledrejection", (e) => reportClientError("unhandled_rejection", e.reason));
}

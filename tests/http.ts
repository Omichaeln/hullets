import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "../apps/api/src/router.ts";
import { createHttpServer } from "../apps/api/src/server.ts";
import type { Harness } from "./helpers.ts";
import type { AddressInfo } from "node:net";
/** Boots the real Express + tRPC surface on an ephemeral port for adversarial API tests. */
export async function httpHarness(h: Harness) {
  const server = createHttpServer(h.app).listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = (token?: string | null) => createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${base}/trpc`, headers: token ? { authorization: `Bearer ${token}` } : {} })] });
  const status = async (fn: () => Promise<unknown>) => { try { await fn(); return 200; } catch (e) { const x = e as { data?: { httpStatus?: number } }; return x.data?.httpStatus ?? 500; } };
  return { base, client, status, close: () => new Promise<void>((r) => server.close(() => r())) };
}

import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import type { App } from "@promo/core";
import { can, csvCell } from "@promo/core";
import { appRouter } from "./router.ts";
import type { Context } from "./trpc.ts";
import { contractDocument } from "./contract.ts";

const CONSOLE_DIST = path.resolve("apps/console/dist");
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

/** HTTP surface: provider webhook (durable-then-ack), tRPC API, authenticated media/exports, health, static console. */
export function createHttpServer(app: App) {
  const ex = express(); ex.disable("x-powered-by"); ex.set("trust proxy", true);
  ex.use((req, res, next) => { const origin = String(req.headers.origin ?? ""); if (origin && app.cfg.CORS_ORIGINS.includes(origin)) { res.setHeader("access-control-allow-origin", origin); res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS"); res.setHeader("access-control-allow-headers", "content-type,authorization,x-correlation-id"); res.setHeader("vary", "Origin"); if (req.method === "OPTIONS") return res.status(204).end(); } res.setHeader("x-frame-options", "DENY"); res.setHeader("referrer-policy", "no-referrer"); res.setHeader("x-content-type-options", "nosniff"); res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()"); if (!req.path.startsWith("/trpc") && !req.path.startsWith("/webhooks")) res.setHeader("content-security-policy", CSP); res.setHeader("cache-control", "no-store"); next(); });
  const correlation = (req: Request) => String(req.headers["x-correlation-id"] ?? "").slice(0, 64) || `req_${crypto.randomBytes(8).toString("hex")}`;
  const bearerOf = (req: Request) => { const h = String(req.headers.authorization ?? ""); return h.startsWith("Bearer ") ? h.slice(7).trim() : null; };
  const requireUser = async (req: Request, res: Response, permission: Parameters<typeof can>[1]) => { const user = await app.auth.authenticate(bearerOf(req) ?? undefined); if (!user) { res.status(401).json({ error: { code: "UNAUTHORIZED", message: "authentication required" } }); return null; } if (user.mustChangePassword || !can(user.roles, permission)) { res.status(403).json({ error: { code: "FORBIDDEN", message: "not permitted" } }); return null; } return user; };

  // ---- provider webhook: verify, persist every event, then acknowledge
  ex.get("/webhooks/whatsapp", (req, res) => { const hs = app.transport.verifyHandshake?.(new URLSearchParams(req.query as Record<string, string>)); if (!hs) return res.status(404).end(); res.status(hs.status).type("text/plain").send(hs.body); });
  ex.post("/webhooks/whatsapp", express.raw({ type: "*/*", limit: "4mb" }), async (req, res) => {
    const raw = req.body as Buffer;
    if (app.transport.validateSignature) { if (!app.transport.validateSignature(req.headers as Record<string, string>, raw)) { await app.signals.metric("webhook.bad_signature"); await app.observability.record({ source: "webhook", code: "BAD_SIGNATURE", message: "webhook signature did not verify", path: "/webhooks/whatsapp", detail: { ip: req.ip ?? "unknown", bytes: raw.length } }); return res.status(403).json({ error: { code: "BAD_SIGNATURE", message: "invalid signature" } }); } }
    else if (app.environment === "production") return res.status(403).json({ error: { code: "FORBIDDEN", message: "simulated webhooks are disabled in production" } });
    let payload: unknown; try { payload = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ error: { code: "VALIDATION", message: "malformed JSON" } }); }
    let events; try { events = app.transport.parseInbound(payload); } catch { return res.status(400).json({ error: { code: "VALIDATION", message: "unrecognised payload" } }); }
    let accepted = 0, deduped = 0;
    try { for (const ev of events) { const r = await app.queue.receive(ev); if (r.accepted) accepted++; else deduped++; } }
    catch (e) { app.log.error({ err: (e as Error).message }, "webhook persist failed"); await app.observability.record({ source: "webhook", code: "INTAKE_UNAVAILABLE", message: (e as Error).message, path: "/webhooks/whatsapp", detail: { events: events.length } }); return res.status(503).json({ error: { code: "INTAKE_UNAVAILABLE", message: "could not persist the event; retry" } }); }
    res.status(200).json({ received: events.length, accepted, deduped });
  });

  ex.get("/health/live", (_req, res) => res.json({ ok: true }));
  ex.get("/health/ready", async (_req, res) => { try { await app.db.execute("select 1"); const x = await app.extractor.health(); const st = await app.storage.health(); const ok = x.ok && st.ok; res.status(ok ? 200 : 503).json({ ok, database: true, extractor: x, storage: st, transport: app.transport.health(), worker: app.worker.health() }); } catch (e) { res.status(503).json({ ok: false, error: (e as Error).message }); } });
  ex.get("/api/contract.json", (_req, res) => res.json(contractDocument()));

  // ---- authenticated receipt media (bearer header only; never a capability URL)
  ex.get("/api/media/:submissionId", async (req, res) => {
    const user = await requireUser(req, res, "submission.media"); if (!user) return;
    const s = await app.pipeline.get(req.params.submissionId); if (!s?.mediaAssetId) return res.status(404).end();
    const a = await app.media.get(s.mediaAssetId); const normalised = req.query.v === "normalised"; const bytes = a ? await app.media.bytes(a, { normalised }) : null; if (!a || !bytes) return res.status(404).end();
    await app.audit.record(app.db, { actorType: "staff", actorId: user.id, action: "media.viewed", targetType: "submission", targetId: s.id, campaignId: s.campaignId, payload: { normalised } });
    res.setHeader("content-type", normalised ? "image/png" : a.mime); res.setHeader("content-disposition", "inline"); res.setHeader("cache-control", "private, no-store"); res.send(bytes);
  });
  ex.get("/api/export/:scope.csv", async (req, res) => {
    const user = await requireUser(req, res, "report.export"); if (!user) return;
    const scope = req.params.scope; const cid = String(req.query.campaignId ?? "") || (await app.campaigns.current())?.id; if (!cid) return res.status(404).end();
    let rows: Array<Record<string, unknown>>; try { rows = (await app.reports.exportRows(scope, cid)) as Array<Record<string, unknown>>; } catch { return res.status(400).json({ error: { code: "VALIDATION", message: "unknown scope" } }); }
    await app.audit.record(app.db, { actorType: "staff", actorId: user.id, action: "report.export", targetType: "report", targetId: scope, campaignId: cid, reason: `${rows.length} rows (csv)` });
    const head = rows[0] ? Object.keys(rows[0]) : []; res.setHeader("content-type", "text/csv; charset=utf-8"); res.setHeader("content-disposition", `attachment; filename=${scope}.csv`); res.setHeader("x-export-watermark", `${user.email} ${new Date().toISOString()}`);
    res.send([head.join(","), ...rows.map((r) => head.map((k) => csvCell(r[k])).join(","))].join("\r\n"));
  });
  ex.get("/api/draws/:drawId/bundle.json", async (req, res) => { const user = await requireUser(req, res, "draw.bundle"); if (!user) return; try { const b = await app.draws.bundle(req.params.drawId, user.id); res.setHeader("content-disposition", `attachment; filename=draw-${req.params.drawId}.json`); res.json(b); } catch { res.status(404).end(); } });

  // ---- tRPC
  ex.use("/trpc", express.json({ limit: "20mb" }), createExpressMiddleware({ router: appRouter, createContext: async ({ req }): Promise<Context> => { const bearer = bearerOf(req); return { app, user: bearer ? await app.auth.authenticate(bearer) : null, bearer, correlationId: correlation(req), ip: req.ip ?? "unknown" }; }, onError: ({ error, path: p }) => { if (error.code === "INTERNAL_SERVER_ERROR") app.log.error({ path: p, err: (error.cause as Error)?.message ?? error.message }, "trpc internal error"); } }));

  // ---- console (built assets) with SPA fallback
  if (fs.existsSync(path.join(CONSOLE_DIST, "index.html"))) { ex.use(express.static(CONSOLE_DIST, { index: false, maxAge: "1h", setHeaders: (r, p) => { if (p.endsWith(".html")) r.setHeader("cache-control", "no-cache"); } })); ex.get(/^\/(?!trpc|api|webhooks|health).*/, (_req, res) => res.sendFile(path.join(CONSOLE_DIST, "index.html"))); }
  ex.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "not found" } }));
  ex.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => { app.log.error({ err: err.message }, "http error"); if (!err.status || err.status >= 500 || err.status === 413) void app.observability.record({ source: "http", code: err.status === 413 ? "PAYLOAD_TOO_LARGE" : "INTERNAL", message: err.message, path: `${req.method} ${req.path}`.slice(0, 200), correlationId: correlation(req), detail: { status: err.status ?? 500 } }); res.status(err.status && err.status < 500 ? err.status : 500).json({ error: { code: err.status === 413 ? "PAYLOAD_TOO_LARGE" : "INTERNAL", message: err.status && err.status < 500 ? err.message : "internal error" } }); });
  return ex;
}

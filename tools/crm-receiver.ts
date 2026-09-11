/**
 * Local CRM contract receiver (TEST ONLY): implements the generic HTTP contract
 * the http-contract adapter speaks — PUT /records/:type/:key (409 on an older
 * version), GET /records/:type/:key, GET /records, GET /health — with fault
 * injection (POST /fault {mode: none|down|timeout-after-write|slow}) for the
 * reliability tests. Run standalone: npm run crm:receiver (port 8090).
 */
import http from "node:http";
export function createReceiver() {
  const records = new Map<string, Record<string, unknown>>(); let fault: "none" | "down" | "timeout-after-write" | "slow" = "none";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x"); const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    const json = (status: number, o: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && url.pathname === "/fault") { fault = body?.mode ?? "none"; return json(200, { fault }); }
    if (url.pathname === "/health") return fault === "down" ? json(503, { ok: false }) : json(200, { ok: true, records: records.size });
    if (fault === "down") { res.destroy(); return; }
    const m = url.pathname.match(/^\/records\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && url.pathname === "/records") return json(200, { records: [...records.values()] });
    if (m && req.method === "PUT") { const key = `${decodeURIComponent(m[1])}:${decodeURIComponent(m[2])}`; const ex = records.get(key); if (ex && Number(ex.entity_version) > Number(body.entity_version)) return json(409, { error: "older version" }); records.set(key, { id: `crm_${key}`, entity_type: decodeURIComponent(m[1]), external_key: decodeURIComponent(m[2]), entity_version: body.entity_version, ...body.record, updated_at: new Date().toISOString() }); if (fault === "timeout-after-write") { return; /* never answers: the write happened, the client times out */ } if (fault === "slow") await new Promise((r) => setTimeout(r, 1500)); return json(200, { id: `crm_${key}` }); }
    if (m && req.method === "GET") { const r = records.get(`${decodeURIComponent(m[1])}:${decodeURIComponent(m[2])}`); return r ? json(200, r) : json(404, { error: "not found" }); }
    json(404, { error: "not found" });
  });
  return { server, records, setFault: (f: typeof fault) => { fault = f; } };
}
if (process.argv[1] && /crm-receiver\.ts$/.test(process.argv[1])) { const port = Number(process.env.CRM_RECEIVER_PORT ?? 8090); createReceiver().server.listen(port, "127.0.0.1", () => console.log(`[crm-receiver] listening on http://127.0.0.1:${port} (TEST ONLY contract receiver)`)); }

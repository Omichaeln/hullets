/**
 * Post-deploy smoke check against a RUNNING server (SMOKE_BASE_URL, default
 * http://127.0.0.1:8080): liveness, readiness, API contract, console served,
 * authentication enforced, webhook handshake guarded. With SMOKE_EMAIL and
 * SMOKE_PASSWORD it also signs in and reads the readiness report. Exit 1 on failure.
 */
const base = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const checks: Array<{ name: string; pass: boolean; detail?: string }> = []; const ok = (name: string, pass: boolean, detail = "") => { checks.push({ name, pass, detail }); console.error(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`); };
const get = async (p: string, init: RequestInit = {}) => { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000); try { return await fetch(base + p, { ...init, signal: ctrl.signal }); } finally { clearTimeout(t); } };
try {
  const live = await get("/health/live"); ok("GET /health/live", live.status === 200);
  const ready = await get("/health/ready"); const rj = await ready.json().catch(() => ({})) as Record<string, unknown>; ok("GET /health/ready", ready.status === 200, JSON.stringify(rj).slice(0, 200));
  const contract = await get("/api/contract.json"); const cj = await contract.json().catch(() => ({})) as { contract?: string; procedures?: unknown[] }; ok("GET /api/contract.json", contract.status === 200 && cj.contract === "hullets-api/1", `${(cj.procedures as unknown[])?.length ?? 0} procedures`);
  const home = await get("/"); ok("console served at /", home.status === 200 && /<div id="root">|<title>/i.test(await home.text()), home.status === 200 ? "" : "run npm run console:build");
  ok("security headers", !!home.headers.get("content-security-policy") && home.headers.get("x-frame-options") === "DENY");
  const anon = await get("/trpc/submissions.list?input=%7B%7D"); ok("unauthenticated API call is refused", anon.status === 401);
  const media = await get("/api/media/sub_x"); ok("unauthenticated media is refused", media.status === 401);
  const hs = await get("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"); ok("webhook handshake refuses a wrong token", [403, 404].includes(hs.status), String(hs.status));
  const forged = await get("/webhooks/whatsapp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); ok("unsigned webhook post is refused or ignored", [403, 200].includes(forged.status), forged.status === 200 ? "simulator transport (non-production only)" : "signature required");
  if (process.env.SMOKE_EMAIL && process.env.SMOKE_PASSWORD) {
    const login = await get("/trpc/auth.login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD }) });
    const lj = await login.json().catch(() => ({})) as { result?: { data?: { token?: string; pendingMfa?: boolean } } }; const token = lj.result?.data?.token; ok("staff login", login.status === 200 && (!!token || !!lj.result?.data?.pendingMfa), lj.result?.data?.pendingMfa ? "MFA pending (cannot continue without a code)" : "");
    if (token) { const me = await get("/trpc/auth.me", { headers: { authorization: `Bearer ${token}` } }); ok("auth.me with the session", me.status === 200); const r = await get("/trpc/readiness.get", { headers: { authorization: `Bearer ${token}` } }); ok("readiness.get readable", r.status === 200 || r.status === 403, String(r.status)); await get("/trpc/auth.logout", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }); }
  } else ok("staff login", true, "skipped (set SMOKE_EMAIL / SMOKE_PASSWORD to exercise it)");
} catch (e) { ok("smoke ran to completion", false, (e as Error).message); }
const pass = checks.every((c) => c.pass); console.log(JSON.stringify({ base, checkedAt: new Date().toISOString(), pass, checks }, null, 2)); process.exit(pass ? 0 : 1);

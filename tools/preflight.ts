// Environment preflight: dependencies, configuration, database + migrations, storage, provider modes. Never prints secret values. Exit 1 on blocking problems.
import fs from "node:fs";
import path from "node:path";
import { loadConfig, validateConfig, CONFIG_DOC } from "@promo/core";
import { createPool } from "@promo/db";
const cfg = loadConfig(); const checks: Array<{ name: string; pass: boolean; detail: string; blocking: boolean }> = [];
const ok = (name: string, pass: boolean, detail = "", blocking = true) => checks.push({ name, pass, detail, blocking });
ok("node >= 22.12", Number(process.versions.node.split(".")[0]) >= 22, process.version);
for (const dep of ["sharp", "tesseract.js", "@tesseract.js-data/eng", "drizzle-orm", "@trpc/server"]) ok(`dependency ${dep}`, fs.existsSync(path.resolve("node_modules", dep, "package.json")), "run npm ci");
try { const sharp = (await import("sharp")).default; ok("sharp renders", (await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')).png().toBuffer()).length > 0); } catch (e) { ok("sharp renders", false, (e as Error).message); }
const problems = validateConfig(cfg); ok("configuration valid for environment", problems.length === 0, problems.join("; "));
for (const c of CONFIG_DOC) if (c.secret) ok(`secret ${c.name}`, cfg.isLocal || !!process.env[c.name], process.env[c.name] ? "set" : "not set", ["DATA_KEY", "AUDIT_SIGNING_KEY"].includes(c.name) && !cfg.isLocal);
try { const pool = createPool(cfg.DATABASE_URL, { max: 1 }); const r = await pool.query("select current_database() db, version() v"); ok("database reachable", true, `${r.rows[0].db} · ${String(r.rows[0].v).split(",")[0]}`); const m = await pool.query("select count(*)::int n from drizzle_migrations").catch(() => ({ rows: [{ n: 0 }] })); const files = fs.readdirSync(path.resolve("packages/db/migrations")).filter((f) => f.endsWith(".sql")).length; ok("migrations applied", m.rows[0].n === files, `${m.rows[0].n}/${files} (run npm run db:migrate)`, false); const env = await pool.query("select value from schema_meta where key='environment'").catch(() => ({ rows: [] as Array<{ value: string }> })); ok("database environment matches", !env.rows[0] || env.rows[0].value === cfg.ENVIRONMENT, `db=${env.rows[0]?.value ?? "unset"} cfg=${cfg.ENVIRONMENT}`, false); const s = await pool.query("select 1 from settings where key='sample_data'").catch(() => ({ rowCount: 0 })); ok("sample data indicator", true, s.rowCount ? "TEST ONLY sample data present" : "no sample data", false); await pool.end(); } catch (e) { ok("database reachable", false, (e as Error).message); }
try { fs.mkdirSync(cfg.MEDIA_ROOT, { recursive: true }); fs.writeFileSync(path.join(cfg.MEDIA_ROOT, ".preflight"), "ok"); fs.rmSync(path.join(cfg.MEDIA_ROOT, ".preflight")); ok("media root writable", true, path.resolve(cfg.MEDIA_ROOT)); } catch (e) { ok("media root writable", false, (e as Error).message); }
ok("whatsapp provider", true, `${cfg.WHATSAPP_PROVIDER}${cfg.WHATSAPP_PROVIDER === "simulator" ? " (SIMULATED — not WhatsApp)" : ""}`, false);
ok("extractor", cfg.EXTRACTOR !== "simulator" || ["local", "test"].includes(cfg.ENVIRONMENT), `${cfg.EXTRACTOR}${cfg.EXTRACTOR === "simulator" ? " (SIMULATED — does not read pixels)" : cfg.EXTRACTOR.startsWith("anthropic") && !cfg.ANTHROPIC_API_KEY ? " (unconfigured: no key)" : ""}`);
ok("crm provider", true, cfg.CRM_PROVIDER === "none" ? "not_configured (events queue visibly)" : `${cfg.CRM_PROVIDER} -> ${cfg.CRM_BASE_URL}`, false);
ok("fixtures present", fs.existsSync(path.resolve("fixtures/receipts/manifest.json")), "run npm run fixtures", false);
ok("console built", fs.existsSync(path.resolve("apps/console/dist/index.html")), "run npm run console:build", false);
const out = { checkedAt: new Date().toISOString(), node: process.version, environment: cfg.ENVIRONMENT, checks, ok: checks.every((c) => c.pass || !c.blocking) };
console.log(JSON.stringify(out, null, 2)); process.exit(out.ok ? 0 : 1);

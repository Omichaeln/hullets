/**
 * Backup + restore rehearsal (§19 / runbook backup-restore.md): pg_dump the
 * configured database, restore it into an isolated database, verify migrations,
 * row counts, the audit hash chain and every draw's stored evidence, then drop
 * the restored copy (keep it with --keep). Never touches the source database.
 * Output: docs/testing/evidence/restore-rehearsal.json. Exit 1 on any failure.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, createApp, silentLogger } from "@promo/core";
import { createPool, ensureDatabase, dropDatabase, schema } from "@promo/db";
import { desc } from "drizzle-orm";

const cfg = loadConfig(); const keep = process.argv.includes("--keep");
const src = new URL(cfg.DATABASE_URL); const srcName = src.pathname.slice(1);
const restoredName = `${srcName}_restore_${Date.now().toString(36)}`; const restoredUrl = cfg.DATABASE_URL.replace(/\/[^/?]*(\?|$)/, `/${restoredName}$1`);
const dumpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hullets-dump-")), `${srcName}.dump`);
const checks: Array<{ name: string; pass: boolean; detail?: unknown }> = []; const ok = (name: string, pass: boolean, detail?: unknown) => { checks.push({ name, pass, detail }); console.error(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` · ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); };
const TABLES = ["staff_users", "campaigns", "campaign_versions", "campaign_periods", "outlets", "participants", "enrollments", "inbound_events", "submissions", "extractions", "canonical_receipts", "entries", "draws", "draw_candidates", "winners", "outbound_messages", "crm_events", "audit_events"];
const t0 = Date.now();
try {
  execFileSync("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${dumpFile}`, cfg.DATABASE_URL], { stdio: ["ignore", "ignore", "inherit"] });
  ok("pg_dump completed", fs.existsSync(dumpFile), `${(fs.statSync(dumpFile).size / 1024).toFixed(0)} KiB in ${Date.now() - t0} ms`);
  await ensureDatabase(restoredUrl);
  const t1 = Date.now();
  execFileSync("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${restoredUrl}`, dumpFile], { stdio: ["ignore", "ignore", "inherit"] });
  ok("pg_restore completed", true, `${Date.now() - t1} ms into ${restoredName}`);
  const a = createPool(cfg.DATABASE_URL, { max: 2 }), b = createPool(restoredUrl, { max: 2 });
  const mig = async (p: typeof a) => (await p.query("select count(*)::int n, max(created_at) latest from drizzle.drizzle_migrations")).rows[0];
  const ma = await mig(a), mb = await mig(b); ok("migration history identical", ma.n === mb.n && String(ma.latest) === String(mb.latest), { source: ma, restored: mb });
  const counts: Record<string, [number, number]> = {};
  for (const t of TABLES) { const [x, y] = await Promise.all([a.query(`select count(*)::int n from ${t}`), b.query(`select count(*)::int n from ${t}`)]); counts[t] = [x.rows[0].n, y.rows[0].n]; }
  ok("row counts identical for every ledger table", Object.values(counts).every(([x, y]) => x === y), counts);
  const head = async (p: typeof a) => (await p.query("select id, entry_hash from audit_events order by id desc limit 1")).rows[0] ?? null;
  const ha = await head(a), hb = await head(b); ok("audit chain head identical", JSON.stringify(ha) === JSON.stringify(hb), { source: ha, restored: hb });
  await a.end(); await b.end();
  const app = await createApp({ config: { ...cfg, DATABASE_URL: restoredUrl }, log: silentLogger(), migrate: false });
  const v = await app.audit.verify(); ok("audit hash chain verifies on the restored copy", v.ok, { total: v.total, broken: v.brokenCount });
  const [cp] = await app.db.select().from(schema.auditCheckpoints).orderBy(desc(schema.auditCheckpoints.createdAt)).limit(1);
  if (cp) ok("latest signed checkpoint verifies with the configured AUDIT_SIGNING_KEY", (await app.audit.verifyCheckpoint(cp)).signatureOk); else ok("signed checkpoint present", false, "no checkpoint yet (run audit.checkpoint)");
  const draws = await app.db.select().from(schema.draws);
  const drawChecks = await Promise.all(draws.map(async (d) => ({ id: d.id, status: d.status, ...(await app.draws.verifyStored(d)) })));
  ok("every draw's stored evidence recomputes", drawChecks.every((d) => d.ok), drawChecks.map((d) => `${d.id}:${d.status}:${d.ok ? "ok" : d.problems.join("|")}`));
  const media = await app.db.select().from(schema.mediaAssets).limit(25); let present = 0;
  for (const m of media) if (await app.storage.get(m.storageKey)) present++;
  ok("media objects referenced by the ledger exist in storage (sample of 25)", media.length === 0 || present === media.length, `${present}/${media.length} · storage is outside the database dump: back it up separately (runbook)`);
  await app.close();
} catch (e) { ok("rehearsal ran to completion", false, (e as Error).message); }
finally {
  if (!keep) { try { await dropDatabase(restoredUrl); ok("restored copy dropped", true, restoredName); } catch (e) { ok("restored copy dropped", false, (e as Error).message); } } else console.error(`[restore] kept ${restoredName}`);
  fs.rmSync(path.dirname(dumpFile), { recursive: true, force: true });
}
const out = { generatedAt: new Date().toISOString(), source: srcName, restoredAs: restoredName, kept: keep, durationMs: Date.now() - t0, pass: checks.every((c) => c.pass), checks };
const dir = path.resolve("docs/testing/evidence"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "restore-rehearsal.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2)); process.exit(out.pass ? 0 : 1);

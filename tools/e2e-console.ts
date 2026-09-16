/**
 * Browser end-to-end run of the staff console (Playwright, Chromium) against a
 * freshly started API on the seeded SAMPLE database: every role signs in and opens
 * every page it may see (console errors are captured), then a client UAT journey
 * runs through the UI: a participant registers and enters via the simulator, a
 * reviewer decides a queued review, the draw officer freezes and executes the open
 * week, the approver approves, fulfilment publishes and contacts a winner, the
 * auditor verifies the chain. Screenshots (desktop + mobile) and a results file are
 * written to docs/testing/evidence. Refuses to run against a production database.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Page, type Browser } from "playwright";
import { createApp, silentLogger } from "@promo/core";

const PORT = Number(process.env.E2E_PORT ?? 18080); const BASE = `http://127.0.0.1:${PORT}`; const PW = "E2eConsolePassword2026";
const STAFF = { manager: "manager@example.test", reviewer: "reviewer@example.test", support: "support@example.test", draw: "draw@example.test", approver: "approver@example.test", fulfilment: "fulfilment@example.test", auditor: "auditor@example.test", admin: "admin@example.test" } as const;
const OUT = path.resolve("docs/testing/evidence"); const SHOTS = path.join(OUT, "screenshots"); fs.mkdirSync(SHOTS, { recursive: true });
type Step = { name: string; pass: boolean; detail?: string; ms: number }; const steps: Step[] = []; const consoleErrors: Array<{ role: string; url: string; text: string }> = [];
async function step(name: string, fn: () => Promise<string | void>) { const t = Date.now(); try { const d = await fn(); steps.push({ name, pass: true, detail: d ?? undefined, ms: Date.now() - t }); console.error(`ok   ${name}${d ? ` · ${d}` : ""}`); } catch (e) { steps.push({ name, pass: false, detail: (e as Error).message.slice(0, 400), ms: Date.now() - t }); console.error(`FAIL ${name} · ${(e as Error).message.slice(0, 400)}`); } }

// 0. a repeatable starting point: remove and re-seed the SAMPLE campaign (E2E_RESET=0 to keep the current data)
if (process.env.E2E_RESET !== "0") {
  const run = (args: string[]) => new Promise<void>((res, rej) => { const c = spawn(process.execPath, [path.resolve("node_modules/.bin/tsx"), ...args], { stdio: ["ignore", "inherit", "inherit"], env: process.env }); c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${args.join(" ")} exited ${code}`)))); });
  console.error("[e2e] resetting and re-seeding the sample campaign"); await run(["tools/reset-sample.ts", "--confirm"]); await run(["tools/seed.ts"]);
}
// 1. known passwords for the sample staff (test-only helper; sample data only)
const app = await createApp({ log: silentLogger() });
if (app.environment === "production") { console.error("refusing to run the browser UAT against production"); process.exit(2); }
for (const email of Object.values(STAFF)) await app.auth._setPasswordForTests(email, PW);
const campaign = await app.campaigns.current(); if (!campaign) { console.error("seed the sample campaign first (npm run seed)"); process.exit(2); }
await app.close();

// 2. API + console
const server: ChildProcess = spawn(process.execPath, [path.resolve("node_modules/.bin/tsx"), "apps/api/src/main.ts"], { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", WORKER_MODE: "embedded", LOG_LEVEL: "warn" }, stdio: ["ignore", "inherit", "inherit"] });
const up = async () => { for (let i = 0; i < 120; i++) { try { const r = await fetch(`${BASE}/health/live`); if (r.ok) return; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 500)); } throw new Error("api did not start"); };
let browser: Browser | null = null;
try {
  await up();
  // Playwright may be newer than the pre-installed browser; an explicit executable (E2E_CHROMIUM) or the /opt/pw-browsers symlink is used when present.
  const exe = process.env.E2E_CHROMIUM ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ["--disable-features=AutofillServerCommunication,OptimizationHints,Translate", "--disable-background-networking"] });
  const login = async (page: Page, role: keyof typeof STAFF) => { await page.goto(`${BASE}/`); await page.getByLabel("Email").fill(STAFF[role]); await page.getByLabel("Password").fill(PW); await page.getByRole("button", { name: "Sign in" }).click(); await page.getByRole("button", { name: "Sign out" }).waitFor({ timeout: 15_000 }); };
  const newPage = async (role: string, mobile = false) => { const ctx = await browser!.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 }, deviceScaleFactor: 1 }); const page = await ctx.newPage(); page.setDefaultTimeout(12_000); page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push({ role, url: page.url(), text: m.text().slice(0, 300) }); }); page.on("pageerror", (e) => consoleErrors.push({ role, url: page.url(), text: `pageerror: ${e.message.slice(0, 300)}` })); return page; };
  const settle = async (page: Page) => { await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined); await page.waitForTimeout(250); };
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

  // 3. every role, every page it may see
  const PAGES: Array<[string, string]> = [["overview", "/"], ["submissions", "/submissions"], ["submissions-queue", "/submissions?tab=queue"], ["entries", "/entries"], ["participants", "/participants"], ["support", "/support"], ["draws", "/draws"], ["winners", "/winners"], ["campaigns", "/campaigns"], ["master-data", "/master-data"], ["simulator", "/simulator"], ["ops", "/ops"], ["audit", "/audit"], ["staff", "/staff"], ["settings", "/settings"], ["readiness", "/readiness"], ["account", "/account"]];
  for (const role of Object.keys(STAFF) as Array<keyof typeof STAFF>) {
    const page = await newPage(role);
    await step(`${role}: sign in`, async () => { await login(page, role); });
    const nav = await page.locator(".tt-nav a").allTextContents();
    for (const [name, url] of PAGES) {
      const allowed = nav.some((t) => url === "/" ? t === "Overview" : url.startsWith("/submissions") ? t.startsWith("Submissions") : url === "/master-data" ? t.startsWith("Outlets") : url === "/ops" ? t.startsWith("Integrations") : url === "/staff" ? t === "Access" : url === "/settings" ? t === "Settings" : url === "/account" ? t === "My account" : t.toLowerCase().startsWith(url.slice(1).split("?")[0].replace("-", " ")));
      if (!allowed && url !== "/account" && url !== "/readiness") { await step(`${role}: ${name} hidden from navigation`, async () => { await page.goto(`${BASE}${url}`); await page.locator(".tt-content .callout.danger, .tt-content h1").first().waitFor({ timeout: 15_000 }); await settle(page); const body = await page.locator(".tt-content").innerText(); if (!/forbidden|requires permission|Nothing|not found|Page not found|limited to/i.test(body) && !(await page.locator(".tt-content h1").count())) throw new Error("unexpected content: " + body.slice(0, 120)); return "server refuses the data"; }); continue; }
      await step(`${role}: ${name}`, async () => { await page.goto(`${BASE}${url}`); await settle(page); await page.locator(".tt-content h1").first().waitFor({ timeout: 15_000 }); const errs = await page.locator(".callout.danger").allTextContents(); const internal = errs.filter((e) => /internal error/i.test(e)); if (internal.length) throw new Error(internal.join(" | ")); if (role === "manager" || role === "reviewer" || role === "fulfilment" || role === "admin") await shot(page, `${role}-${name}-desktop`); return errs.length ? `${errs.length} callout(s): ${errs.join(" | ").slice(0, 120)}` : undefined; });
    }
    await page.context().close();
  }
  // mobile layout for the main screens
  { const page = await newPage("manager-mobile", true); await step("mobile: sign in and open the menu", async () => { await login(page, "manager"); await page.goto(`${BASE}/submissions`); await settle(page); await shot(page, "manager-submissions-mobile"); await page.getByRole("button", { name: "Open menu" }).click(); await page.waitForTimeout(300); await shot(page, "manager-menu-mobile"); await page.goto(`${BASE}/`); await settle(page); await shot(page, "manager-overview-mobile"); }); await page.context().close(); }

  // 4. client UAT journey through the UI
  const phone = `26377${String(Date.now()).slice(-7)}`; let reference = "";
  { const page = await newPage("support-uat"); await login(page, "support"); await page.goto(`${BASE}/simulator`); await settle(page);
    const say = async (t: string) => { await page.locator("input.mono").first().fill(phone); await page.getByPlaceholder("Type as the participant…").fill(t); await page.getByRole("button", { name: "Send", exact: true }).click(); await page.waitForTimeout(600); await settle(page); };
    await step("UAT-1: participant registers through the simulator", async () => { await say("hi"); await say("1"); await say("Uat"); await say("Tester"); await say("TESTUAT1X"); await say("Harare"); await say("yes"); await say("yes"); const t = await page.locator(".chat").innerText(); if (!/registered|Welcome/i.test(t)) throw new Error("registration reply missing: " + t.slice(-300)); await shot(page, "uat-1-registration"); });
    await step("UAT-2: participant chooses an outlet and sends a fresh receipt (real OCR)", async () => { await say("2"); await say("mopani westgate harare"); await say("1"); await page.selectOption("select.select", { label: (await page.locator("select.select option").allTextContents()).find((x) => x.startsWith("uat-fresh-1-A"))! }); await page.getByRole("button", { name: "Send photo" }).click(); await page.waitForTimeout(1500); await settle(page); for (let i = 0; i < 20; i++) { const t = await page.locator(".chat").innerText(); const m = t.match(/reference is (R-[A-Z0-9]{4}-[A-Z0-9]{4})/); if (m) reference = m[1]; if (/entry has been added|qualified entries/i.test(t)) { if (!reference) throw new Error("qualified but no reference captured"); await shot(page, "uat-2-receipt-qualified"); return reference; } if (/already been used/i.test(t)) throw new Error("fixture already credited in this database: " + t.slice(-200)); await page.getByRole("button", { name: "Refresh" }).click(); await page.waitForTimeout(1500); } throw new Error("no qualification message within 30s"); });
    await page.context().close(); }
  { const page = await newPage("reviewer-uat"); await login(page, "reviewer");
    await step("UAT-3: reviewer sees the new submission as qualified with its receipt image", async () => { await page.goto(`${BASE}/submissions`); await settle(page); await page.getByPlaceholder("Reference").fill(reference); await settle(page); await page.locator("tr.clickable").first().click(); await page.locator(".tt-content h1").waitFor(); await page.locator("img.receipt-img").waitFor({ timeout: 15_000 }); const h = await page.locator(".tt-content h1").innerText(); if (!/Qualified/i.test(h)) throw new Error("not qualified: " + h); await shot(page, "uat-3-review-workspace"); });
    await step("UAT-4: reviewer takes a queued review and decides it", async () => { await page.goto(`${BASE}/submissions?tab=queue`); await settle(page); if (!(await page.locator("tr.clickable").count())) return "queue empty (nothing to decide)"; await page.locator("tr.clickable").first().click(); await page.locator(".tt-content h1").waitFor(); const take = page.getByRole("button", { name: "Take this review" }); if (await take.isVisible().catch(() => false)) { await take.click(); await settle(page); } await page.getByRole("button", { name: "Not qualified", exact: true }).click(); const dlg = page.getByRole("dialog"); await dlg.getByLabel(/Reason code/).selectOption({ index: 1 }); await dlg.getByLabel(/Reviewer note/).fill("UAT: decided from the console"); await dlg.getByRole("button", { name: "Not Qualified", exact: true }).click(); await settle(page); const h = await page.locator(".tt-content h1").innerText(); if (!/Not Qualified/i.test(h)) throw new Error("decision not applied: " + h); await shot(page, "uat-4-review-decided"); });
    await page.context().close(); }
  let drawUrl = "";
  { const page = await newPage("draw-uat"); await login(page, "draw");
    await step("UAT-5: draw officer freezes and executes the open week", async () => { await page.goto(`${BASE}/draws`); await settle(page); const opts = await page.locator("select.select").nth(1).locator("option").allTextContents(); const w1 = opts.find((o) => o.startsWith("W-1")); if (w1) await page.locator("select.select").nth(1).selectOption({ label: w1 }); await settle(page); const freeze = page.getByRole("button", { name: "Freeze draw", exact: true }); if (!(await freeze.isEnabled())) { const b = await page.locator(".callout").first().innerText(); throw new Error("barrier blocks the draw: " + b.slice(0, 200)); } await freeze.click(); await page.getByRole("button", { name: "Freeze", exact: true }).click(); await page.waitForURL(/\/draws\/drw_/); await settle(page); drawUrl = page.url(); await shot(page, "uat-5-draw-frozen"); await page.getByRole("button", { name: "Execute", exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: "Execute" }).click(); await settle(page); const h = await page.locator(".tt-content h1").innerText(); if (!/Executed/i.test(h)) throw new Error("not executed: " + h); await shot(page, "uat-5-draw-executed"); return drawUrl; });
    await page.context().close(); }
  { const page = await newPage("approver-uat"); await login(page, "approver");
    await step("UAT-6: a different person approves after the integrity check", async () => { await page.goto(drawUrl); await settle(page); await page.getByRole("button", { name: "Approve", exact: true }).click(); await page.getByLabel(/Approval note/).fill("UAT approval from the console"); await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click(); await settle(page); const h = await page.locator(".tt-content h1").innerText(); if (!/Approved/i.test(h)) throw new Error("not approved: " + h); await shot(page, "uat-6-draw-approved"); });
    await page.context().close(); }
  { const page = await newPage("fulfilment-uat"); await login(page, "fulfilment");
    await step("UAT-7: fulfilment publishes the draw, downloads nothing it may not, and contacts a winner", async () => { await page.goto(drawUrl); await settle(page); await page.getByRole("button", { name: /Publish & create winner records/ }).click(); await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click(); await settle(page); await shot(page, "uat-7-draw-published"); await page.locator("td a").filter({ hasText: /Selected/ }).first().click(); await page.locator(".tt-content h1").waitFor(); await page.getByRole("button", { name: "Send winner message" }).click(); await page.getByRole("dialog").getByRole("button", { name: "Send" }).click(); await settle(page); const t = await page.locator(".tt-content").innerText(); if (!/Claim reference sent/i.test(t)) throw new Error("no claim reference shown"); await shot(page, "uat-7-winner-notified"); });
    await page.context().close(); }
  { const page = await newPage("auditor-uat"); await login(page, "auditor");
    await step("UAT-8: the auditor verifies the audit chain and exports the draw bundle", async () => { await page.goto(`${BASE}/audit`); await settle(page); await page.getByRole("button", { name: "Verify chain" }).click(); await page.locator(".callout.success").waitFor({ timeout: 15_000 }); await shot(page, "uat-8-audit-verified"); await page.goto(drawUrl); await settle(page); const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download audit bundle" }).click()]); const p = await dl.path(); const bundle = JSON.parse(fs.readFileSync(p!, "utf8")) as { bundleVersion: string }; if (bundle.bundleVersion !== "draw-bundle/1") throw new Error("unexpected bundle"); return dl.suggestedFilename(); });
    await page.context().close(); }
} finally {
  await browser?.close(); server.kill("SIGTERM");
}
const out = { generatedAt: new Date().toISOString(), base: BASE, pass: steps.every((s) => s.pass) && consoleErrors.length === 0, steps, consoleErrors, screenshots: fs.readdirSync(SHOTS).sort() };
fs.writeFileSync(path.join(OUT, "e2e-console.json"), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(OUT, "e2e-console.md"), [`# Console end-to-end run`, ``, `Generated ${out.generatedAt} · ${steps.filter((s) => s.pass).length}/${steps.length} steps passed · ${consoleErrors.length} browser console errors · result **${out.pass ? "PASS" : "FAIL"}**`, ``, `| Step | Result | Detail | ms |`, `|---|---|---|---|`, ...steps.map((s) => `| ${s.name} | ${s.pass ? "pass" : "**FAIL**"} | ${(s.detail ?? "").replace(/\|/g, "/")} | ${s.ms} |`), ``, consoleErrors.length ? `## Browser console errors\n\n${consoleErrors.map((e) => `- ${e.role} ${e.url}: ${e.text}`).join("\n")}` : "", `## Screenshots\n\n${out.screenshots.map((s) => `- screenshots/${s}`).join("\n")}`, ``].join("\n"));
console.log(JSON.stringify({ pass: out.pass, steps: steps.length, failed: steps.filter((s) => !s.pass).map((s) => s.name), consoleErrors: consoleErrors.length }, null, 2));
process.exit(out.pass ? 0 : 1);

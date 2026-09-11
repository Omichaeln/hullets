// Populated TEST ONLY seed: sample campaign, 80 outlets, periods, decisions, staff and (with --journeys or by default) real fixture journeys.
import { createApp } from "@promo/core";
import { ensureSampleCampaign, ensureSampleStaff } from "./lib/sample.ts";
import { runSampleJourneys } from "./lib/journeys.ts";
const app = await createApp();
if (app.environment === "production") { console.error("refusing to seed sample data in production"); process.exit(2); }
const c = await ensureSampleCampaign(app); console.log(c.seeded ? `[seed] created ${c.campaign.code}` : `[seed] ${c.campaign.code} already present`);
for (const s of await ensureSampleStaff(app)) console.log(`[seed] staff ${s.email} (${s.roles.join(",")}) temporary password: ${s.temporaryPassword}`);
if (!process.argv.includes("--light")) await runSampleJourneys(app);
const cp = await app.audit.checkpoint("seed"); console.log(`[seed] audit checkpoint ${cp?.id ?? "none"} (${cp?.signed ? "signed" : "UNSIGNED: set AUDIT_SIGNING_KEY"})`);
await app.close(); process.exit(0);

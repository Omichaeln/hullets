import { loadConfig } from "@promo/core";
import { createPool, createDb, migrate, ensureDatabase } from "@promo/db";
const cfg = loadConfig();
if (process.argv.includes("--create")) { const created = await ensureDatabase(cfg.DATABASE_URL); console.log(created ? "database created" : "database exists"); }
const pool = createPool(cfg.DATABASE_URL, { max: 2 }); const db = createDb(pool);
await migrate(db); console.log("migrations applied"); await pool.end();

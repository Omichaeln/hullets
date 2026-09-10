import { loadConfig } from "@promo/core";
import { ensureDatabase } from "@promo/db";
const cfg = loadConfig(); console.log((await ensureDatabase(cfg.DATABASE_URL)) ? "database created" : "database already exists");

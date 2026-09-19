import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";

export * as schema from "./schema.ts";
export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function createPool(url: string, options: { max?: number; statementTimeoutMs?: number; connectionTimeoutMs?: number } = {}) {
  return new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: 30_000,
    maxUses: 10_000,
    application_name: process.env.SERVICE_NAME ?? "promo-engine",
  });
}
export function createDb(pool: pg.Pool): Db { return drizzle(pool, { schema, casing: "snake_case" }); }
/** Advisory lock id for schema migration. Distinct from the audit-chain and draw locks. */
export const MIGRATION_LOCK = 4_242_900;
/**
 * Migrate under a session-scoped advisory lock.
 *
 * Drizzle's migrator takes no lock: it reads the last applied migration OUTSIDE
 * a transaction and then applies pending statements inside one. Two processes
 * starting together both read the same watermark and both attempt the same DDL,
 * so one crashes on a duplicate object — and the deployment topology starts an
 * API and two workers at once. The lock serialises them; the loser waits, then
 * reads a watermark that already includes the winner's work and applies nothing.
 */
export async function migrate(db: Db, pool?: pg.Pool) {
  const p = pool ?? (db as unknown as { $client?: pg.Pool }).$client;
  if (!p) throw new Error("migrate needs the pool backing this database to take the migration lock");
  const client = await p.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await drizzleMigrate(db, { migrationsFolder: MIGRATIONS_DIR, migrationsTable: "drizzle_migrations" });
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
export async function ensureDatabase(url: string) { const u = new URL(url); const name = u.pathname.replace(/^\//, ""); u.pathname = "/postgres"; const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); try { const r = await c.query("select 1 from pg_database where datname=$1", [name]); if (!r.rowCount) await c.query(`create database "${name.replace(/"/g, '""')}"`); return !r.rowCount; } finally { await c.end(); } }
export async function dropDatabase(url: string) { const u = new URL(url); const name = u.pathname.replace(/^\//, ""); u.pathname = "/postgres"; const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); try { await c.query(`drop database if exists "${name.replace(/"/g, '""')}" with (force)`); } finally { await c.end(); } }

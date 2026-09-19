import { eq, and, lt, sql } from "drizzle-orm";
import { schema, type Db } from "@promo/db";

const { authAttempts } = schema;

/**
 * Database-backed failed-authentication counters.
 *
 * Previously a per-process Map, which had three problems: the limit reset on
 * every deploy, it multiplied by replica count, and nothing swept it. Shared
 * state fixes all three. The counter is deliberately cheap — one upsert per
 * failure, one read per attempt — because it sits in front of a scrypt
 * verification that costs far more.
 */
export type ThrottleDecision = { limited: boolean; retryAfterSeconds: number; failures: number };

export class AuthThrottle {
  constructor(private db: Db, private windowMs = 60_000, private max = 5) {}

  /** Read-only check. Returns how long to wait when the window is exhausted. */
  async check(kind: string, key: string): Promise<ThrottleDecision> {
    const id = `${kind}:${key}`;
    const [row] = await this.db.select().from(authAttempts).where(eq(authAttempts.key, id));
    if (!row) return { limited: false, retryAfterSeconds: 0, failures: 0 };
    const startedAt = Date.parse(row.windowStartedAt);
    const age = Date.now() - startedAt;
    if (age >= this.windowMs) return { limited: false, retryAfterSeconds: 0, failures: 0 };
    if (row.failures < this.max) return { limited: false, retryAfterSeconds: 0, failures: row.failures };
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((this.windowMs - age) / 1000)), failures: row.failures };
  }

  /** Record a failure, rolling the window when the previous one has expired. */
  async fail(kind: string, key: string): Promise<number> {
    const id = `${kind}:${key}`;
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - this.windowMs).toISOString();
    const [row] = await this.db.insert(authAttempts)
      .values({ key: id, kind, failures: 1, windowStartedAt: now, lastFailureAt: now })
      .onConflictDoUpdate({
        target: authAttempts.key,
        set: {
          // A window older than the limit restarts at one rather than accumulating forever.
          failures: sql`case when ${authAttempts.windowStartedAt} < ${cutoff} then 1 else ${authAttempts.failures} + 1 end`,
          windowStartedAt: sql`case when ${authAttempts.windowStartedAt} < ${cutoff} then ${now} else ${authAttempts.windowStartedAt} end`,
          lastFailureAt: now,
        },
      })
      .returning({ failures: authAttempts.failures });
    return row?.failures ?? 1;
  }

  /** A success clears the counter for that key. */
  async clear(kind: string, key: string) { await this.db.delete(authAttempts).where(eq(authAttempts.key, `${kind}:${key}`)); }

  /** Housekeeping: drop windows that can no longer limit anything. */
  async sweep(olderThanMs = this.windowMs * 10) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const r = await this.db.delete(authAttempts).where(and(lt(authAttempts.windowStartedAt, cutoff))).returning({ key: authAttempts.key });
    return r.length;
  }
}

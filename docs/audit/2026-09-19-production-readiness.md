# Production readiness and scalability audit — 19 September 2026

Scope: the whole system at `dcace4e` — schema, domain services, worker runtime, HTTP surface,
extraction and QR fallback, draws, auth, deployment and delivery. The question asked was not "does
it work" but "what breaks when this carries a real national campaign, and what breaks quietly".

Findings are separated by what I **reproduced** against this code and what I **read but did not
execute**; every claim says which. Severity follows the usual ladder — blocker, major, moderate,
minor — and each remediation is classified as **mandatory baseline**, **recommended default** or
**context-dependent**, so a hard requirement is distinguishable from a preference.

---

## Verdict

**Not production-ready, and the reasons are narrower and more fixable than that phrase usually
implies.** The domain model is the best part of this system: the schema enforces the invariants that
matter in database constraints rather than application checks, the draw sortition is
cryptographically sound, the SSRF defence on the QR fetcher is better than most production code, and
server-side authorisation covers every procedure. That work does not need redoing.

What stops it shipping is a different class of problem. Three of the system's capacity ceilings sit
between **4,000 and 11,000 records** — below the size of one successful week — and all three fail
either silently or with a driver-level error that names nothing. One authentication control is
bypassable by setting an HTTP header. One new feature lets an attacker-controlled web server supply
the facts that decide whether an entry is awarded. And the release gate that is supposed to catch
all of this does not run anywhere, has ten failing tests, and cannot complete its own final step.

The single most important structural finding: **adding worker replicas does not increase throughput
on any write path that records an audit event.** That is measured below, not inferred. It does not
stop a launch at modest volume, but it means the scale-out plan in ADR 0007 buys less than it
promises, and it should be understood before capacity is sized.

| | |
|---|---|
| Ship as-is | No |
| Ship after the six blockers below | Yes, for a campaign bounded at roughly 10,000 entries per draw period |
| Ship at national scale | Not until the draw, duplicate and retention ceilings are lifted and a real-receipt soak test exists |
| Estimated remediation to first safe launch | 3–5 engineering days for the blockers; 2–3 weeks for the full plan |

---

## What was verified, and how

Everything in this section was executed against this checkout on Node 22.22 and PostgreSQL 16.13.

| Check | Result |
|---|---|
| `npm run typecheck` | **Pass**, clean across API, core, tools, tests and console |
| `npm run lint` | **Pass**, clean |
| `npm test` | **Fail — 10 of 137 tests fail** (5 of 16 files) |
| `npm run audit:deps` | **Fails to execute** — npm rejects the package tree |
| Draw freeze at scale | **Reproduced hard failure at 10,923 entries** (10,922 succeeds) |
| Audit-chain write throughput | **Measured: flat at 578/s, then 75/s, independent of concurrency 1→16** |
| Drizzle migrator locking | **Read the installed migrator — no advisory lock** |
| CI pipeline | **Does not exist** — no `.github/`, no pipeline configuration of any kind |

Not verified, and flagged as such throughout: live Meta Cloud API behaviour, real S3 behaviour,
Anthropic and OpenAI verification paths, and end-to-end throughput with real OCR under sustained
load. Those need an environment this audit did not have.

---

## Blockers

### B-1 · The draw cannot be frozen above 10,922 entries — reproduced

`DrawService.freeze()` inserts every eligible entry as one `INSERT ... VALUES` statement:

```ts
if (b.eligible.length) await tx.insert(drawCandidates).values(b.eligible.map((c, i) => ({ … })));
```

`draw_candidates` binds six parameters per row. PostgreSQL's wire protocol carries the parameter
count in a 16-bit field, so the statement breaks at 65,535 parameters — exactly 10,922 rows.

I ran this against a real database. 10,922 rows insert. 10,923 fails with:

```
bind message has 2 parameter formats but 0 parameters
```

That message names neither the draw, nor the limit, nor the cause. It surfaces to the draw officer
as an opaque internal error on draw day, after the barrier has passed and the period has been
closed — which is the worst possible moment to discover a capacity limit.

There is a second, independent ceiling in the same method: excluded candidates are written at
`position: 100_000 + i`, so a period with more than 100,000 eligible entries collides with the
exclusion rows on the `(drawId, position)` primary key.

A campaign that awards 11,000 entries in a week is a *small* campaign. This is the first wall the
system hits, and it hits it early.

**Remediation — mandatory baseline.** Chunk the inserts (2,000 rows per statement is comfortable),
or better, replace the round trip entirely with `INSERT … SELECT` so the candidate set never leaves
the database:

```ts
const CHUNK = 2000;
for (let i = 0; i < rows.length; i += CHUNK) await tx.insert(drawCandidates).values(rows.slice(i, i + CHUNK));
```

Move exclusions to a separate `status`-discriminated ordering rather than a magic offset, and add a
test that freezes a period with 25,000 synthetic entries. The same chunking audit should be applied
to `setCampaignOutlets` and `importOutletsCsv`, which share the pattern at higher row counts.

### B-2 · The login throttle is bypassable with a request header — read, high confidence

`server.ts` sets `ex.set("trust proxy", true)`. With every proxy trusted, `req.ip` is the leftmost
value of the client's own `X-Forwarded-For` header. The login throttle keys on it:

```ts
const keyOf = (ip: string, email: string) => `${ip}|${email.trim().toLowerCase()}`;
```

An attacker who varies that header gets a fresh bucket on every request, so the documented "5
failures per minute" control does not exist against anyone who reads the response headers.

Two consequences compound it. First, unlimited credential stuffing against named staff accounts.
Second — and more immediately dangerous — `verifyPassword` calls `crypto.scryptSync` with N=2¹⁵,
which blocks the Node event loop for roughly 100 ms and allocates 32 MB per call. With the throttle
removed, a few requests per second of login attempts against one known-valid staff address saturate
the API process: legitimate webhook traffic is shed with 503s while the event loop grinds through
scrypt. `WORKER_MODE=embedded` is the default, so the same process is also doing OCR.

`verifyMfa` is not throttled at all. A six-digit TOTP with unlimited attempts, against a challenge
the attacker can re-create indefinitely by re-submitting the stolen password, is not a second
factor.

**Remediation — mandatory baseline.**
1. Set `trust proxy` to the actual hop count (`ex.set("trust proxy", 1)` behind Railway's single
   proxy), so `req.ip` becomes the edge-observed address rather than a client-supplied string.
2. Throttle `verifyMfa` on `userId` with the same window, and cap total MFA attempts per challenge
   at five before invalidating it.
3. Move password verification off the event loop — `crypto.scrypt` (callback/promise form) rather
   than `scryptSync`. This is a one-line change with a large blast radius reduction.
4. Persist the throttle. The current `Map` is per-process, so the effective limit already multiplies
   by replica count and resets on every deploy. A `staff_login_attempts` table, or the edge proxy,
   is the right home.

### B-3 · The QR fiscal fallback lets a third-party server decide qualification — read, high confidence

This is the newest feature (ADR 0008, dated today) and it is the one I would not launch with.

The fallback fires precisely when OCR is incomplete: `shouldTry` is true when the document is not
recognised as a receipt, or there are no line items, or fields are missing, or confidence is below
0.6. When it fires, `mergeFacts` fills every empty OCR field from the fetched document — receipt
number, date, total, merchant, **and line items**:

```ts
const useDigitalLines = !ocr.lines.length || (!ocr.lines.some(x => x.product) && digital.lines.some(x => x.product));
```

And `evaluate()` then *suppresses* the low-confidence review trigger because a QR document was
parsed:

```ts
const qrBacked = facts.evidence?.qr?.status === "parsed";
if (conf != null && conf < rules.review.minOcrConfidence && !qrBacked) add("ocr_confidence", "unknown", …);
```

`QR_ALLOWED_HOSTS` defaults to empty, and `hostAllowed` treats empty as "any public HTTPS host".

The attack is therefore: print a receipt-shaped image that OCR cannot read, carrying a QR code
pointing at your own HTTPS endpoint. The worker fetches it. Your JSON supplies the merchant name
(satisfying `outlet_match` against whichever outlet you selected), the date (satisfying
`purchase_date`), the receipt number (minting a fresh `canonical_receipt` key, so duplicate
prevention never engages), and two lines of the qualifying product (satisfying
`qualifying_product`). The `qrBacked` flag suppresses the confidence gate. The submission
auto-qualifies. Repeat with a new receipt number for unlimited entries — `caps` default to `null`,
meaning unlimited.

ADR 0008 states that a QR fallback "cannot override campaign dates, participating-outlet rules,
product qualification, receipt identity, duplicate prevention, caps". That is true only in the sense
that it does not *replace* a value OCR read. When OCR reads nothing — the exact condition that
triggers the fallback — the fetched document is the sole source for all of them. The asserted
security property does not hold.

**Remediation — mandatory baseline.**
1. **Fail closed on the allowlist.** An empty `QR_ALLOWED_HOSTS` must disable the fallback, not
   permit the entire public internet. This is a three-line change and closes the path on its own.
2. Never let digital line items alone produce `qualified`. When `qr_lines_used` is set and OCR
   produced no product lines, force `review`. The reviewer has the image; the machine does not have
   trustworthy evidence.
3. Do not let `qrBacked` suppress the confidence gate unless the fetched host is on the allowlist.
4. Correct ADR 0008 to state the property the code actually provides.

`QR_FALLBACK_ENABLED=false` is a valid interim mitigation and the ADR already documents it as the
rollback switch. I would set it now and leave it off until (1) and (2) ship.

### B-4 · Duplicate detection silently stops covering older receipts at 4,000 submissions — read, high confidence

```ts
.orderBy(desc(submissions.createdAt)).limit(4000);
```

`visualCandidates()` compares the incoming image's perceptual hashes against the **newest 4,000
submissions in the campaign**, in application memory. Byte-identical re-uploads are still caught by
the indexed `sha256` lookup, which has no limit, and a re-photograph whose receipt number and date
OCR can read is still caught by the canonical-receipt key. The visual net is the backstop for the
remaining case: a re-photograph of the same purchase whose identity fields OCR cannot recover.

That backstop stops covering a receipt once 4,000 newer submissions exist — which, for a campaign of
any size, is within days. Nothing logs it, nothing alerts, and the coverage loss starts with the
*earliest* receipts.

The same method is also a performance problem: 4,000 rows joined and transferred per submission,
then roughly 8,000 BigInt Hamming operations on the main thread. The `ix_media_dhash` index cannot
serve it, because a B-tree cannot answer a Hamming-distance query — the index is dead weight.

**Remediation — recommended default.** Move the comparison into the database with a BK-tree or,
more simply, PostgreSQL's `bit_count(a # b)` over `bit(64)` columns with a bounded candidate set
drawn from a blocking key (same outlet, ±3 days). Failing that, at minimum: scope the window by
outlet and date rather than by row count, and raise an alert when a campaign's submission count
exceeds the window so the degradation is visible rather than silent.

### B-5 · `npm run check` — the release gate — fails, and nothing runs it anyway

There is no CI. No `.github/`, no pipeline of any kind. `npm run check` is documented as the gate
and exists only as a script someone has to remember to type.

Run today, on `main`'s tip, it fails twice:

**Ten tests fail.** Five files, 137 tests, 10 red. The bulk are conversational-copy and flow
assertions left behind by the last eight commits — the outlet-confirmation step, the returning-user
menu and the greeting handler all changed without their tests. Those are stale, not broken. But two
are not:

- `review.test.ts` — "a reviewer can qualify an image with unreadable identity fields" expects
  `review`, gets **`duplicate`**. A submission that should reach a human is being auto-classified as
  a duplicate. This one needs diagnosis before launch, not a test update.
- `security.test.ts` T-15 — expects `IDENTITY_INCOMPLETE`, gets `VALIDATION`. Commit `72e5326`
  ("allow audited manual qualification") deliberately relaxed the control from *cannot credit
  without receipt identity* to *can credit without identity if a reviewer types a note*. That may be
  the right call. But the test written to protect the old guarantee was left failing rather than
  rewritten to state the new one, so the suite no longer asserts any version of the control.

**`npm run audit:deps` cannot execute.** `.npmrc` sets `legacy-peer-deps=true`, which produces a
tree npm's own auditor rejects:

```
Invalid package tree, run npm install to rebuild your package-lock.json
```

Two packages resolve extraneous (`@emnapi/runtime`, `@img/sharp-wasm32`). `.npmrc` also sets
`audit=false`. So the final step of the release gate is a no-op that would fail if it ran. The
readiness document records it as passing with "2 moderate advisories"; that result is from an
earlier tree and is no longer reproducible.

**Remediation — mandatory baseline.** A pipeline on every push running `typecheck`, `lint`, `test`,
`console:build` and a dependency scan, with a PostgreSQL service container. Main branch protected on
it. Then: triage the ten failures — update the eight copy assertions, diagnose the
`duplicate`-instead-of-`review` case, and rewrite T-15 to assert whatever the manual-qualification
control is now *meant* to be. Resolve the peer-dependency conflict so the tree is auditable, or
replace `npm audit` with a scanner that reads the lockfile directly.

### B-6 · Concurrent migrations on deploy — read the installed migrator, high confidence

Migrations run twice per process and once per replica: `railway.json`'s start command runs
`db:migrate`, and then `createApp()` runs `migrate(db)` again on boot.

Drizzle's PostgreSQL migrator takes **no lock**. It reads the last applied migration *outside* a
transaction, then applies pending statements inside one:

```js
const dbMigrations = await session.all(sql`select … order by created_at desc limit 1`);
const lastDbMigration = dbMigrations[0];
await session.transaction(async (tx) => { … });
```

Two processes starting together both read the same watermark and both attempt the same DDL. One
crashes on a duplicate object — and under ADR 0007's target topology (one API plus two workers) a
deploy starts three migrators at once. A migration containing DML would be applied twice.

**Remediation — mandatory baseline.** Wrap the migration in `pg_advisory_lock` with a dedicated key
(the codebase already uses this pattern for the audit chain and draws), remove the duplicate call
from `createApp()` by defaulting `opts.migrate` to `false` outside tests, and run migrations as a
Railway pre-deploy command rather than in the service start path.

---

## Major findings

### M-1 · Audited writes do not scale horizontally — measured

`AuditService.record()` takes a single global advisory lock, held for the remainder of the caller's
transaction:

```ts
await t.execute(sql`select pg_advisory_xact_lock(${CHAIN_LOCK})`);
```

This is a deliberate and correct design choice: it is what stops the hash chain forking. The cost is
that **every audited write in the entire system serialises**, and the ceiling is `1 / transaction
duration` regardless of how many processes are running.

I measured it against a real database:

| In-transaction work after `record()` | Concurrency 1 | Concurrency 8 | Concurrency 16 |
|---|---|---|---|
| None | 578/s | 554/s | 593/s |
| ~10 ms (5 round trips) | 73/s | 74/s | **75/s** |

Concurrency buys nothing. It cannot — the lock is global.

This matters because `ReceiptPipeline.commit()` calls `audit.record()` and then, still inside the
transaction, performs several further round trips: `campaigns.get()`, `campaigns.outlet()`,
`crm.emit()`, `participants.get()`, and `outcomeMessage()` which issues four more queries. On a
managed database with ~1 ms RTT that is comfortably 10 ms of lock-held time, which puts the whole
platform at roughly 75 audited writes per second. A qualifying receipt costs three of them
(`submission.received`, `entry.awarded`, `submission.qualified`), so the ceiling is about **25
receipts per second, system-wide, no matter how many workers you deploy.**

That is survivable for a first campaign. It is not what ADR 0007 leads a reader to expect.

**Remediation — recommended default.** Do not abandon the chain; shorten the lock. Move every read
that does not need to be transactional (`campaigns.get`, `campaigns.outlet`, `activeVersion`,
`outcomeMessage`'s content lookup) *before* the transaction opens, and make `audit.record()` the
last statement before commit rather than the middle. That alone should recover most of the gap
between 75/s and 578/s. If more headroom is needed later, the chain can be sharded per campaign with
a lock key derived from `campaignId` — the chain's purpose is per-campaign tamper evidence, not a
single global sequence.

### M-2 · The CRM event escapes the transaction it is documented to be inside

`ReceiptPipeline.commit()` is documented as "ONE transaction committing decision, award, audit,
participant message and CRM event". Four of those five are in the transaction. `CrmService.emit()`
is not:

```ts
const r = await this.db.insert(crmEvents).values({ … })   // this.db, not the caller's tx
```

It writes on a *different pooled connection*. If the enclosing transaction rolls back, the CRM event
survives, and the vendor is told about an entry that was never awarded.

There is a second consequence. Opening a transaction takes a connection from the pool; issuing
`this.db` queries from inside it takes another. `DB_POOL_MAX` defaults to 10. Under enough
concurrency, every connection holds a transaction waiting for a connection that will never free —
classic pool-starvation deadlock, which presents as the whole service hanging rather than erroring.

The same pattern appears in `commit()`'s `campaigns.get()`, `campaigns.outlet()` and
`participants.get()` calls, and in `outcomeMessage()`.

**Remediation — mandatory baseline.** Thread `DbOrTx` through `CrmService.emit()` exactly as
`OutboxService.enqueue()` and `AuditService.record()` already do, and pass `tx`. Audit every service
method reachable from inside a transaction for `this.db` usage; a lint rule or a
transaction-scoped wrapper type would prevent recurrence. Separately, size `DB_POOL_MAX` against
`HTTP_MAX_IN_FLIGHT` — 200 in-flight requests against 10 connections is a queue, not a pool.

### M-3 · `audit.verify()` loads the entire audit table into memory

```ts
const rows = await this.db.select({ … }).from(auditEvents).where(gt(auditEvents.id, fromId)).orderBy(asc(auditEvents.id));
```

No limit, no streaming. It is exposed at `audit.verify` to any holder of `audit.read` (auditor,
platform_admin), and it recomputes SHA-256 over every row on the main thread. `audit_events` is the
fastest-growing table in the system and is never pruned by design. At a few million rows this is an
out-of-memory kill of the API process, triggered by a single click in the console.

**Remediation — mandatory baseline.** Verify in bounded pages with a cursor, resuming from the
previous page's head hash — the function already accepts `fromId`, so the shape is there. Return
progress rather than a single verdict, and run full verification as a job rather than a synchronous
request. The signed checkpoints already make incremental verification sound.

### M-4 · Housekeeping's scheduling degrades from daily to roughly once a minute

`completeJob()` nulls the dedupe key on success:

```ts
await this.db.update(jobs).set({ status: "done", finishedAt: …, leaseUntil: null, dedupeKey: null })
```

`uq_jobs_dedupe` is a partial index over non-null keys, so a completed job no longer blocks
re-enqueueing the same key. Housekeeping runs every 40 ticks (~60 s at the default poll interval)
and re-enqueues all three periodic jobs each time. The comment says otherwise:

```ts
await this.deps.queue.enqueueJob(…, "audit.checkpoint", …, { dedupeKey: `audit.checkpoint:${…slice(0,10)}` }); // a signed chain head every day
```

In practice `audit_checkpoints` gains roughly 1,440 rows per day per worker replica instead of one,
and `winners.expireDue()` runs every minute instead of hourly. Neither is dangerous today. Both are
unbounded growth and wasted work, and the mismatch between the stated and actual schedule will
mislead whoever debugs this later.

**Remediation — recommended default.** Keep the dedupe key on completion and expire it by time
instead (add `dedupe_until`, or include the key in a `completed_dedupe` uniqueness window). Assert
the intended cadence in a test.

### M-5 · `reviewQueue()` is unbounded and is called by the alerting path

```ts
const open = await this.db.select({ … }).from(reviewTasks).innerJoin(submissions, …).innerJoin(participants, …).where(ne(reviewTasks.state, "decided")).orderBy(asc(reviewTasks.createdAt));
```

Every open review task, joined twice, with no limit — loaded into memory and mapped to a full item
list purely to produce a count and an overdue tally. `Worker.housekeeping()` calls it on every
housekeeping cycle.

The failure mode is self-reinforcing. Set `AI_VERIFICATION_REQUIRED=true` and lose the provider:
every submission that would qualify becomes `review` instead. The review queue grows into six
figures. Housekeeping then loads all of it, every cycle, in the same process that is trying to drain
the backlog. The mechanism that is supposed to tell you there is a backlog is the one that dies of
it.

**Remediation — mandatory baseline.** Split the method. `reviewQueueStats()` should be three
aggregate queries returning counts, oldest and overdue — that is all housekeeping needs. The console
listing keeps a paginated `items` query with an explicit limit.

### M-6 · A 20 MB JSON body limit against a 200-request admission budget

```ts
ex.use("/trpc", (req, res, next) => { if (!admit(req, res, "api")) return; next(); }, express.json({ limit: "20mb" }), …)
```

Admission control counts the request *before* the body is parsed, so 200 concurrent 20 MB bodies is
4 GB of buffered JSON. The limit exists for `simulator.inbound`'s base64 image field, which is
capped at 16 MB in its own Zod schema — but that route is staff-only and non-production, while the
20 MB limit applies to every procedure including unauthenticated `publicRouter`.

**Remediation — recommended default.** Default the tRPC body limit to 256 KB and mount the
simulator route separately with its own larger limit, or move simulator uploads to a dedicated
multipart endpoint. Consider basing admission on bytes in flight rather than request count.

---

## Moderate findings

### Md-1 · MFA breaks under horizontal scaling

`AuthService.pendingMfa` is an in-memory `Map`. A challenge created on replica A cannot be verified
on replica B — the user gets "no pending MFA challenge; sign in again", indefinitely, at random, as
soon as there is more than one API replica. The map is also never pruned. **Mandatory baseline** if
MFA is to be relied on: persist the challenge (a short-lived row keyed by user, or a signed
stateless token). Note also that MFA is not *required* for any role — `mfaEnabled` defaults false
and no policy enforces it. For a system where one role can unmask national identity numbers and
another approves draws, MFA on privileged roles should be mandatory, not opt-in.

### Md-2 · Media retention can stall, and the query cannot use an index

```ts
const rows = await this.db.select().from(mediaAssets).where(and(eq(mediaAssets.status, "stored"))).limit(5000);
… for (const a of rows) { if (!a.expiresAt || Date.parse(a.expiresAt) > now) continue; … }
```

Expiry is filtered in JavaScript *after* the limit, with no `ORDER BY`. Whether anything is purged
depends on the physical order in which PostgreSQL happens to return 5,000 of potentially millions of
rows — which it does not guarantee, particularly after vacuum and page reuse. Raw receipt images are
personal data with a stated 90-day retention (D-22); a retention job whose correctness rests on
undefined row ordering is a compliance finding, not a performance one. **Mandatory baseline:**
`where(and(eq(status,'stored'), lt(expiresAt, now)))` with `orderBy(asc(expiresAt))` and a supporting
index. Record purged counts as a metric so a stall is visible.

### Md-3 · Every inbound message re-reads and re-parses the campaign configuration

There is no caching anywhere in the read path. A single WhatsApp message triggers
`campaigns.current()`, `activeVersion()`, `controls()`, `participants.byUid()`, `enrollment()`,
`session()`, and — for any outlet interaction — `campaignOutlets()`, which returns *every*
participating outlet and filters in JavaScript, up to three times within one message. On top of that
sit four Zod `.parse()` calls per message over rules, content, flags and prize plan, re-run for data
that changes approximately never.

At 80 outlets this is invisible. At 5,000 it is 15,000 rows transferred per outlet-selection
message. **Recommended default:** a small in-process TTL cache (30–60 s) on the active campaign, its
parsed version and its outlet list, invalidated on `activateVersion` and `setCampaignOutlets`. The
version rows are already immutable once active, which makes them trivially cacheable.

### Md-4 · `metrics` is an unbounded time series in the transactional database

`OpsSignals.metric()` inserts a row per business event — submissions received, decided, outbound
sent. At 100,000 receipts a day that is roughly half a million rows a day, forever, with no
retention, no rollup and no partitioning, in the same instance serving the participant journey.
`counts()` aggregates across the whole window on read. **Recommended default:** partition by month
and drop old partitions, or roll up hourly and retain raw rows for 7 days. If observability is going
to matter at national scale, this is the point at which an external metrics backend earns its
operational cost.

### Md-5 · `/health/live` is the deployment health check

`railway.json` points at `/health/live`, which returns `{ok:true}` unconditionally. `/health/ready`
— which actually checks the database, extractor, storage and verifier — is not wired to anything. A
deploy with a broken `DATABASE_URL` is marked healthy and promoted. **Mandatory baseline:** point
`healthcheckPath` at `/health/ready`. Be aware that `/health/ready` calls `verifier.health()`, which
should be cached or made non-blocking so probes do not hit an external AI provider on every poll.

### Md-6 · Audit exports truncate silently at 50,000 rows

`exportRows()` caps at 50,000 and the CSV route reports `count: rows.length` — which equals the cap.
An auditor receives a file that reads as complete and is not. **Mandatory baseline** for anything
labelled an audit export: compare against a `count(*)`, and either stream the full set or refuse
with an explicit "N rows exceed the export limit" rather than truncating.

### Md-7 · Running TypeScript through `tsx` in production

`npm start` is `tsx apps/api/src/main.ts`. The Dockerfile copies the full build-stage `node_modules`
into the runtime image, so Playwright, vitest, drizzle-kit and the TypeScript compiler all ship to
production. That inflates the image, widens the attack surface, and makes `npm audit --omit=dev` a
misleading measure of runtime exposure. **Recommended default:** compile to JavaScript in the build
stage and run the output with a pruned production dependency tree.

### Md-8 · `readiness.get` tells any signed-in user which admins still hold a temporary password

The procedure is `sessionProcedure` — authenticated, but with no permission requirement — and
returns the full staff list with emails, roles, MFA status and `temporaryPassword` flags. A
`promotion_assistant` can enumerate exactly which privileged accounts have never changed their
bootstrap credential. **Recommended default:** gate it behind `ops.read`, and drop the per-user
detail to an aggregate count for anyone without `staff.manage`.

---

## Minor findings

| # | Finding | Remediation |
|---|---|---|
| Mn-1 | `login()` short-circuits before `verifyPassword` for unknown emails; scrypt takes ~100 ms, so valid addresses are distinguishable by timing | Hash against a dummy record on the miss path |
| Mn-2 | Claim references are 48 bits hashed with unsalted SHA-256 | Use the existing `FieldCipher.fingerprint` (HMAC) so a database leak does not yield offline-brute-forceable claim tokens |
| Mn-3 | `newReference()` is 40 bits; collisions become likely around 10⁶ submissions, and the unique index is global rather than per-campaign | Widen to 10 characters, or scope uniqueness to the campaign |
| Mn-4 | No `Strict-Transport-Security` header | Add HSTS with `includeSubDomains` once the production domain is fixed |
| Mn-5 | Expired `staff_sessions` rows are never deleted | Add to the housekeeping sweep |
| Mn-6 | `participants.search` uses `ilike '%…%'` across three columns — a sequential scan per staff search | `pg_trgm` GIN index, or require a minimum prefix |
| Mn-7 | `media.store()` writes objects and the asset row outside the submission transaction; a rollback orphans both | Accept and sweep, or move the row into the transaction |
| Mn-8 | `normalisePhone` leaves a number without a leading zero or country code unqualified, so staff-entered numbers can create a second participant for the same person | Require E.164 on staff input paths |
| Mn-9 | `OpsSignals.raise()` does select-then-insert with no constraint, so concurrent workers duplicate alerts | Partial unique index on `(kind)` where `acked_at is null` |
| Mn-10 | The `transient` flag set on media-download failures in `Worker.processEvent` is never read | Remove it or honour it in the retry decision |
| Mn-11 | Running the test suite rewrites `docs/testing/evidence/ocr-pipeline-results.json`, so the tree is dirty after `npm test` | Write to a gitignored path and copy on an explicit evidence refresh |

---

## The scalability model

Stated plainly, so capacity can be sized against numbers rather than adjectives. Constraints are
ordered by **when they bite**, not by severity.

| Ceiling | Limit | Scales with replicas? | Failure mode |
|---|---|---|---|
| Visual duplicate window | 4,000 submissions per campaign | No | **Silent** — coverage degrades, nothing reports it |
| Media retention sweep | 5,000-row unordered scan | No | **Silent** — may purge nothing |
| Draw freeze | **10,922 entries per period** | No | Cryptic driver error, on draw day |
| Draw positions | 100,000 entries per period | No | Primary key violation |
| OCR throughput | ~1.5 receipts/s per process (681 ms p50 per the repo's own benchmark, single serialised tesseract worker) | **Yes** | Queue age grows |
| Platform, audited writes | **~25 receipts/s system-wide** (measured 75 audited writes/s at 10 ms transactions; 3 per qualifying receipt) | **No** | Queue age grows, unfixably by scaling out |
| Repo's own load benchmark | 9.5 receipts/s, 4 worker loops, **simulated** extractor | — | p95 latency 17 s at 200 receipts |

Two observations follow.

**The three lowest ceilings are all below the size of one good week, and all three are quiet.** A
campaign that attracts 5,000 receipts has already lost part of its duplicate protection and may have
stopped honouring its retention policy, with no signal in either case. At 11,000 entries the draw
simply refuses, with an error that names nothing.

**Worker replicas only help with OCR.** That is real and worth doing — OCR is the dominant cost per
receipt and scales cleanly. But the platform cost behind it does not, and the repo's own load
benchmark is measuring the platform cost with OCR removed: 9.5 receipts per second with queue depth
climbing monotonically for 17 of its 21 seconds. That number is a drain rate, not a sustainable
arrival rate, and it should not be read as headroom.

---

## Remediation plan

Sequenced by risk retired per day of work, not by severity.

**Stage 1 — before any real traffic (3–5 days)**

1. Set `QR_FALLBACK_ENABLED=false`. One environment variable, closes B-3 immediately.
2. `trust proxy` hop count; `crypto.scrypt` async; throttle `verifyMfa` (B-2).
3. Chunk the `draw_candidates` insert and add a 25,000-entry freeze test (B-1).
4. Advisory lock around migrations; remove the duplicate `migrate()` from `createApp()` (B-6).
5. Thread `tx` through `CrmService.emit()` (M-2).
6. Bound `audit.verify()` and split `reviewQueue()` (M-3, M-5).
7. Stand up CI and make it green. Triage the ten failures — in particular the
   `duplicate`-instead-of-`review` case, which is the only one that might be a live defect (B-5).

**Stage 2 — before scale (1–2 weeks)**

8. Fail-closed QR allowlist; force review when digital line items alone would qualify (B-3, properly).
9. Move duplicate detection into the database; scope by outlet and date (B-4).
10. Fix the retention query and add a purged-count metric (Md-2).
11. Shorten the audit lock by hoisting non-transactional reads out of `commit()` (M-1).
12. Persist the MFA challenge and require MFA for `draw_approver`, `fulfilment`, `auditor`,
    `platform_admin` (Md-1).
13. Configuration cache on the campaign read path (Md-3).
14. `/health/ready` as the deployment probe; compile TypeScript for the production image (Md-5, Md-7).

**Stage 3 — before declaring national capacity**

15. Execute ADR 0007's split (API service plus worker replicas, S3 media) — the ADR is sound and the
    entry points already exist.
16. Partition or externalise `metrics` (Md-4).
17. **A soak test with real receipts at 2–3× expected peak, with real OCR, for a sustained period.**
    ADR 0007 already names this as required and it has not been done. Every throughput number in
    this repository, including mine, is either simulated or micro-benchmarked. Nothing here
    substitutes for that test.

---

## What I did not verify

Stated explicitly so this report is not read as covering more than it does.

- **Live Meta Cloud API behaviour.** The signature verification and handshake code reads correctly
  and uses constant-time comparison, but no credentials were available. Rate limits, template
  approval behaviour and the 24-hour service window are untested against the real platform.
- **S3 storage.** `S3Storage` was read, not exercised. `validateConfig` requires it in production,
  so the first real use will be in production unless staging exercises it first.
- **The Anthropic and OpenAI verification paths.** Read only. Note that `AI_VERIFICATION_REQUIRED`
  with an unconfigured provider sends every submission to review — correct fail-closed behaviour,
  but it interacts badly with M-5.
- **End-to-end throughput with real OCR under sustained load.** See Stage 3.
- **The console beyond routing and permission wiring.** No accessibility, browser-compatibility or
  front-end performance assessment was performed.
- **`restore:rehearsal`, `bench:load`, `bench:receipts` and `test:e2e`** were not re-run; the
  committed evidence for all four predates the last eight commits and should be regenerated once the
  suite is green.

---

## What is genuinely strong

Worth recording, because an audit that lists only defects misrepresents the system.

The **schema** puts integrity where it belongs. `uq_entry_canonical`, `uq_draw_live` as a partial
unique index, `uq_version_active`, the `check` constraints on campaign and period windows — these
are invariants the database refuses to violate, not conventions the application hopes to maintain.
Most systems of this kind enforce all of it in application code and discover the gap during a
dispute.

The **draw engine** is correct. HMAC-SHA256 keyed by a committed seed, sorted lexicographically on
the full 256-bit digest, with a deterministic tie-break — no modulo bias, and genuinely reproducible
from the exported bundle. Commit-then-reveal ordering, separation of duties enforced in
`approve()`, and an independent verifier that re-implements the mathematics deliberately rather than
importing it. This is the part of the system most likely to be challenged publicly, and it would
hold up.

The **SSRF defence** in `qr.ts` is better than most production code: DNS resolution checked against
private ranges, the connection pinned to the resolved address with the original SNI and Host header,
every redirect hop revalidated. That defeats DNS rebinding, which most implementations of this
pattern do not. B-3 is a trust-boundary failure in what the fetched content is allowed to *decide* —
not a failure of the fetcher itself.

**Authorisation** is complete. Every tRPC procedure outside `auth` and the two deliberately public
ones carries a permission guard, checked server-side, with the temporary-password gate applied ahead
of it. The read-wide/act-narrow policy in `policy.ts` is coherently argued and correctly implemented.

The **transactional outbox** models `unknown_outcome` as a first-class state rather than guessing,
and the CRM adapter refuses to mark delivered on a 200 alone — it reads back and confirms the
version. That is a level of honesty about distributed failure that is rare.

And the **audit chain**'s `columnsAgreeWithBody` check — catching a privileged operator who rewrites
`actor_id` in place while the chain still verifies — is the kind of finding that usually only
surfaces after an incident.

The problems in this report are real and several are serious. None of them are in the parts that
would have been hardest to get right.

# Huletts Promotions — WhatsApp receipt promotion platform

A WhatsApp-native promotion engine for a retail brand: consumers register, photograph a till receipt, and are awarded draw entries when the purchase meets the campaign rules. Staff run reviews, draws, prize claims and reporting from a web console. Every consequential action is recorded in a hash-chained audit log.

**Readiness level of this repository: locally testable.** The WhatsApp transport, the receipt extractor used by the automated suites and the CRM are simulated or unconfigured in this checkout; each is labelled as such in the console and the readiness report. See [docs/TEST_READINESS.md](docs/TEST_READINESS.md) for what has been verified and what activation still needs.

## What it does

- **Participant journey on WhatsApp**: menu, registration with terms acceptance, then **capture-first** — send the receipt photo and the system works out the rest. Immediate acknowledgement with a reference, a decision message (entry awarded, not qualified with the reason, duplicate, please re-send, under review), entry status, winners, support hand-off. The participant is asked to *confirm*, and asked to *supply* only what nothing else could establish.
- **Evidence-first verification** ([ADR 0010](docs/adr/0010-evidence-first-verification.md)): sources are ranked — ZIMRA FDMS > receipt image > OCR > AI > participant — and every assertion is recorded rather than collapsed. A receipt carrying a fiscal QR code is verified against the revenue authority's own record of the transaction; the photograph then corroborates that the document submitted *is* that transaction. Where the authority cannot answer, OCR and AI carry the decision. A lower-authority source never overwrites a higher one, but a contradiction is a finding, not a value to discard.
- **Decisions from evidence, not a self-reported score**: a deterministic tier function over what each source asserted, whether they agree, whether the campaign rules passed, and what the duplicate and anomaly checks found. The verification model is one input and can only ever withhold qualification, never grant it.
- **Receipt reading**: image validation and normalisation, offline OCR (tesseract) or Anthropic vision (configured by key), a deterministic parser and typed eligibility rules (integer grams, explicit thresholds, approved caps only). Every decision keeps the facts, the evidence ledger, the rule results and the rules version it was judged under.
- **One award per purchase**: where a fiscal record exists the canonical identity is the transaction's own (`device:fiscalDay:receiptGlobalNo`), which does not depend on reading the paper correctly; otherwise outlet/date/receipt-number with a total cross-check. Image fingerprints for re-photographs, ownership disputes and identity conflicts routed to review, single-transaction commits.
- **Review workspace**: queue with SLA, assignment, escalation, fact correction, duplicate resolution, decisions with participant messaging, safe reprocessing, entry disqualification with an independent approver when a draw is affected.
- **Draws**: barrier checks, frozen snapshot with a committed seed, deterministic HMAC sortition, separation of duties (officer ≠ approver), integrity re-verification, void and re-run, an exportable audit bundle and an independent verifier (`npm run verify:draw`).
- **Winners and claims**: contact with a claim reference, identity verification, acceptance with collection instructions, collection, expiry, alternates, publication as a separate revocable step, masked public listing.
- **Operations**: durable inbound queue and jobs (lease, retry, dead letters, replay), outbox with delivery callbacks and honest unknown outcomes, CRM outbox with read-back confirmation and reconciliation, alerts with runbooks, metrics, exports that are formula-safe and watermarked.
- **Console**: React 19 + tRPC 11 with the TapTap design system; role-gated navigation with server-side enforcement; every consequential action confirmed with a reason.

## Stack

TypeScript (Node 22) modular monolith · PostgreSQL 16 with Drizzle ORM · Express 4 + tRPC 11 · React 19 + Vite · sharp + tesseract.js · vitest + Playwright. Package layout:

```
packages/db       schema, migrations, migrator
packages/core     domain: auth, audit, campaign, participant, conversation, media, extraction,
                  fiscal (ZIMRA FDMS, evidence ledger, tiers), eligibility, receipt pipeline,
                  draws, winners, crm, whatsapp, ops
apps/api          Express + tRPC server, webhook, media/export/bundle endpoints, static console
apps/console      staff console (TapTap design system)
tools/            preflight, migrate, seed, fixtures, benchmarks, restore rehearsal, verifier, smoke, e2e
tests/            unit, integration (throwaway PostgreSQL per suite), real-OCR pipeline suites
docs/             architecture, ADRs, security, testing, integrations, runbooks, release, evidence
```

## Quick start (local)

Requirements: Node ≥ 22.12, PostgreSQL 16 (`pg_dump`/`pg_restore` on the path for the restore rehearsal).

```bash
npm install --legacy-peer-deps
cp .env.example .env            # set DATABASE_URL, DATA_KEY, AUDIT_SIGNING_KEY, BOOTSTRAP_ADMIN_*
npm run db:create               # creates the database named in DATABASE_URL if missing
npm run db:migrate
npm run preflight               # dependencies, configuration, database, storage, provider modes
npm run fixtures                # synthetic receipt images (fictional retailers/products)
npm run seed                    # sample campaign, 80 outlets, staff, fixture journeys (real OCR), a published draw
npm run console:build
npm run dev                     # API + console on http://127.0.0.1:8080 (worker embedded)
```

`npm run seed` prints a one-time temporary password per sample staff account (`manager@example.test`, `reviewer@…`, `support@…`, `draw@…`, `approver@…`, `fulfilment@…`, `auditor@…`); the bootstrap admin comes from `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`. Sign in, change the temporary password, and use **Simulator** to play a participant.

## Checks and evidence

| Command | What it proves |
|---|---|
| `npm run typecheck` · `npm run lint` | type-safe end to end (console included via `apps/console`), lint clean |
| `npm test` | 178 tests: unit (parser, rules, draw engine, evidence ledger, tier decisions, fiscal QR), integration (journeys, ZIMRA-first verification, security/RBAC/privacy, draws, draw capacity, reliability, review), real-OCR pipeline on the labelled fixtures |
| `npm run bench:receipts` | extraction benchmark → `docs/testing/evidence/receipt-benchmark.md` |
| `npm run bench:load` | throughput, latency and exactly-once evidence → `docs/testing/evidence/load-benchmark.md` |
| `npm run restore:rehearsal` | dump, isolated restore, migrations, counts, audit chain and draw evidence → `docs/testing/evidence/restore-rehearsal.json` |
| `npm run test:e2e` | Playwright run of the console: every role, every page, and the client UAT journey → `docs/testing/evidence/e2e-console.md` + screenshots |
| `npm run verify:draw -- bundle.json` | independent recomputation of a draw from its exported bundle |
| `npm run smoke` | post-deploy check of a running server |
| `npm run check` | typecheck + lint + tests + console build + dependency audit — run by CI on every push (`.github/workflows/ci.yml`) |

## Environment variables

Generated from the configuration schema into `.env.example`; every variable is documented there. Secrets are never logged or shown in the console.

## Documentation

- [docs/architecture.md](docs/architecture.md) — components, data flow, state machines, invariants
- [docs/adr](docs/adr) — architecture decision records ([0010](docs/adr/0010-evidence-first-verification.md) is the current verification architecture)
- [docs/audit](docs/audit) — adversarial passes over this tree, with remediation status
- [docs/security/threat-model.md](docs/security/threat-model.md), [role-matrix.md](docs/security/role-matrix.md), [data-lifecycle.md](docs/security/data-lifecycle.md)
- [docs/client-decisions.md](docs/client-decisions.md) — D-01…D-22 with the test values in use
- [docs/requirements-traceability.md](docs/requirements-traceability.md) — FR → code → test
- [docs/testing](docs/testing) — test plan, fixtures, client UAT script, benchmarks, evidence
- [docs/integrations](docs/integrations) — WhatsApp Cloud API, CRM contract, extraction providers
- [docs/runbooks](docs/runbooks) — operations
- [docs/release](docs/release) — activation checklist and go-live
- [docs/design-system.md](docs/design-system.md) — TapTap tokens and components as implemented
- [docs/TEST_READINESS.md](docs/TEST_READINESS.md) — the honest status

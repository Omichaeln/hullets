# Test readiness

> **Updated 19 September 2026.** The figures below predate the production-readiness
> audit ([docs/audit/2026-09-19-production-readiness.md](audit/2026-09-19-production-readiness.md))
> and the evidence-first verification work ([ADR 0010](adr/0010-evidence-first-verification.md)).
> Current state: **`npm run check` passes — 178 tests across 20 files, typecheck,
> lint, console build and dependency audit — and CI runs it on every push.** The
> benchmark and rehearsal evidence in `docs/testing/evidence` has NOT been
> regenerated since those changes and should be treated as stale until it is.
>
> One new dependency is listed below: ZIMRA FDMS. It ships disabled.

**Level reached: locally testable.** Everything in the build prompt's scope is implemented and exercised on this machine against real PostgreSQL, real offline OCR and a real browser. The three external providers are not: WhatsApp (no Meta credentials), the vision extractor (no Anthropic key; tesseract is real and is what the evidence uses), and the CRM (no vendor selected; the HTTP contract is exercised against the bundled receiver). The console, the readiness report and preflight say so wherever those providers appear.

## What was verified (this checkout, 10 September 2026)

| Check | Result | Evidence |
|---|---|---|
| Typecheck (API, core, tools, tests, console) and lint | pass | `npm run typecheck`, `npm run lint` |
| Unit tests (parser, rules, draw engine) | 22 pass | `npm run test:unit` |
| Integration suites (journeys, security/RBAC/privacy/audit, draws and winners, reliability and failure injection, review and ledger) | 42 pass | `npm run test:integration` |
| Real-OCR pipeline on the labelled fixtures, duplicates in four variants, concurrent same-purchase race | 29 pass | `npm run test:ocr`, `docs/testing/evidence/ocr-pipeline-results.json` |
| Receipt extraction benchmark (tesseract) | 34/34 disposition agreement, 100 % labelled fields, p50 0.65 s | `docs/testing/evidence/receipt-benchmark.md` |
| Load benchmark (200 receipts, 40 participants, 4 workers, simulated extractor) | exactly-once, no dead letters, 9.5 receipts/s | `docs/testing/evidence/load-benchmark.md` |
| Backup / restore rehearsal | pass (migrations, counts, chain, checkpoint, draws, media) | `docs/testing/evidence/restore-rehearsal.json` |
| Browser run: every role × every page, mobile layout, client UAT journey U1–U9 | 145 steps pass, 0 browser console errors, 53 screenshots | `docs/testing/evidence/e2e-console.md`, `screenshots/` |
| Dependency audit (`npm audit --omit=dev --audit-level=high`) | pass (2 moderate advisories in express transitive deps, below the gate) | `npm run audit:deps` |
| Production activation validator on the sample campaign | blocks as designed (open decisions, sample markers, providers, evidence) | `tests/integration/security.test.ts` T-36, Readiness page |

## What "integrated client testing" still needs

| Dependency | Owner | Unblocks |
|---|---|---|
| ZIMRA FDMS: the published QR layout and validation-endpoint specification, plus one real fiscal receipt to verify end to end. Until confirmed, `FISCAL_PROVIDER=none` and every receipt takes the OCR path | client / ZIMRA | fiscal verification (tiers 1 and 2), transaction-level duplicate detection |
| Meta Cloud API test number, app secret, verify token, system-user token; winner template approved | client / Meta | real WhatsApp send and receive (T-01, T-04, T-23, T-28 with the real transport), phone-track UAT |
| Anthropic API key (optional; tesseract is the offline default) | client | `anthropic+tesseract` cross-checking |
| 50–200 real receipts across participating retailers, labelled | client | `evidence.receipt_benchmark_accepted` |
| CRM vendor and sandbox (D-19), or approval to launch without CRM | client | T-26 against the vendor |
| Decisions D-01…D-22 approved with evidence | client | production activation |
| Signed client UAT script | client + PointFive | `evidence.client_uat_signoff` |

## Known limitations and honest notes

- The Playwright run resets and re-seeds the sample campaign so it is repeatable; it needs `pg_dump`-free access only to the local database and the pre-installed Chromium.
- Login and MFA throttling is now in the database and holds across replicas; the proxy is still a sensible second layer.
- MFA works across replicas but is not *required* for any role. Requiring it for `draw_approver`, `fulfilment`, `auditor` and `platform_admin` is a product decision that should be made before launch.
- The ZIMRA FDMS QR layout and endpoint shape are configurable and UNVERIFIED — see ADR 0010's "Costs and risks".
- `DATA_KEY` rotation is a documented procedure, not a shipped tool (runbook `key-rotation.md`).
- The TapTap tokens were implemented from the values supplied for this project; the Figma source was not reachable from the build environment.
- No real consumer was messaged, no real draw was run and no paid commitment was made; all names, retailers and receipts are fictional.

## How to refresh this page

```bash
npm run check            # typecheck, lint, tests, console build, dependency audit
npm run bench:receipts && npm run bench:load && npm run restore:rehearsal && npm run test:e2e
```
Then commit `docs/testing/evidence`.

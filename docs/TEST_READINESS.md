# Test readiness

**Level reached: locally testable.** Everything in the build prompt's scope is implemented and exercised on this machine against real PostgreSQL, real offline OCR and a real browser. The three external providers are not: WhatsApp (no Meta credentials), the vision extractor (no Anthropic key; tesseract is real and is what the evidence uses), and the CRM (no vendor selected; the HTTP contract is exercised against the bundled receiver). The console, the readiness report and preflight say so wherever those providers appear.

## What was verified (this checkout, 11 September 2026)

| Check | Result | Evidence |
|---|---|---|
| Typecheck (API, core, tools, tests, console) and lint | pass | `npm run typecheck`, `npm run lint` |
| Unit tests (parser, rules, draw engine, observability primitives) | 30 pass | `npm run test:unit` |
| Integration suites (journeys, security/RBAC/privacy/audit, draws and winners, reliability and failure injection, review and ledger, observability) | 49 pass | `npm run test:integration` |
| Real-OCR pipeline on the labelled fixtures, duplicates in four variants, concurrent same-purchase race | 29 pass | `npm run test:ocr`, `docs/testing/evidence/ocr-pipeline-results.json` |
| Receipt extraction benchmark (tesseract) | 34/34 disposition agreement, 100 % labelled fields, p50 0.65 s | `docs/testing/evidence/receipt-benchmark.md` |
| Load benchmark (200 receipts, 40 participants, 4 workers, simulated extractor) | exactly-once, no dead letters, 9.5 receipts/s | `docs/testing/evidence/load-benchmark.md` |
| Backup / restore rehearsal | pass (migrations, counts, chain, checkpoint, draws, media) | `docs/testing/evidence/restore-rehearsal.json` |
| Browser run: every role × every page, mobile layout, client UAT journey U1–U9, operational visibility OBS-1/OBS-2 | 147 steps pass, 0 browser console errors, 56 screenshots | `docs/testing/evidence/e2e-console.md`, `screenshots/` |
| Operational visibility: error log (API, worker, webhook, console), redaction, fingerprints, resolution, health samples, availability maths, permissions | unit and integration suites T-37 | `tests/unit/observability.test.ts`, `tests/integration/observability.test.ts`, console Uptime & throughput and Error log |
| Dependency audit (`npm audit --omit=dev --audit-level=high`) | pass (2 moderate advisories in express transitive deps, below the gate) | `npm run audit:deps` |
| Production activation validator on the sample campaign | blocks as designed (open decisions, sample markers, providers, evidence) | `tests/integration/security.test.ts` T-36, Readiness page |

## What "integrated client testing" still needs

| Dependency | Owner | Unblocks |
|---|---|---|
| Meta Cloud API test number, app secret, verify token, system-user token; winner template approved | client / Meta | real WhatsApp send and receive (T-01, T-04, T-23, T-28 with the real transport), phone-track UAT |
| Anthropic API key (optional; tesseract is the offline default) | client | `anthropic+tesseract` cross-checking |
| 50–200 real receipts across participating retailers, labelled | client | `evidence.receipt_benchmark_accepted` |
| CRM vendor and sandbox (D-19), or approval to launch without CRM | client | T-26 against the vendor |
| Decisions D-01…D-22 approved with evidence | client | production activation |
| Signed client UAT script | client + PointFive | `evidence.client_uat_signoff` |

## Known limitations and honest notes

- The Playwright run resets and re-seeds the sample campaign so it is repeatable; it needs `pg_dump`-free access only to the local database and the pre-installed Chromium.
- Login throttling is per process; multi-instance deployments should rate-limit at the proxy as well.
- `DATA_KEY` rotation is a documented procedure, not a shipped tool (runbook `key-rotation.md`).
- The TapTap tokens were implemented from the values supplied for this project; the Figma source was not reachable from the build environment.
- No real consumer was messaged, no real draw was run and no paid commitment was made; all names, retailers and receipts are fictional.

## How to refresh this page

```bash
npm run check            # typecheck, lint, tests, console build, dependency audit
npm run bench:receipts && npm run bench:load && npm run restore:rehearsal && npm run test:e2e
```
Then commit `docs/testing/evidence`.

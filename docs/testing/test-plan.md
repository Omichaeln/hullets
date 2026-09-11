# Test plan

## Levels

| Level | Where | Runs against | Purpose |
|---|---|---|---|
| Unit | `tests/unit` | pure functions | parser (dates, numbers, totals, lines, classification), eligibility rules, draw engine (sortition determinism, selection, verifier) |
| Integration | `tests/integration` | a throwaway PostgreSQL database per suite, real migrations, the full app wiring, simulator transport, simulated extractor (fast) | journeys, security/RBAC/privacy, draws and winners, reliability/failure injection, review and ledger operations |
| Real OCR | `tests/ocr` | throwaway database, tesseract | the labelled fixture set through the whole pipeline, duplicates in four variants, concurrent same-purchase race |
| Benchmarks | `tools/bench-receipts.ts`, `tools/bench-load.ts` | tesseract / throwaway database | extraction agreement and latency; throughput and exactly-once under load |
| Rehearsals | `tools/restore-rehearsal.ts` | the configured database | backup → isolated restore → integrity |
| Browser | `tools/e2e-console.ts` | a started API on the seeded sample database, Chromium | every role and page, the client UAT journey, screenshots |
| Smoke | `tools/smoke.ts` | a running deployment | health, contract, auth enforcement, webhook guards |

`npm test` runs the first three levels (about three minutes). `npm run check` adds typecheck, lint, console build and the dependency audit.

## Environments

Tests need `TEST_DATABASE_URL` (default `postgres://promo:promo@127.0.0.1:5432/promo`) with rights to create databases; each suite creates `promo_test_<pid>_<random>` and drops it afterwards. No network is used: the simulator transport records sends, the CRM receiver runs in-process, the Cloud API tests use an injected `fetch`.

## Fixtures

Synthetic receipts (`npm run fixtures`) with fictional retailers and products, labelled in `fixtures/receipts/manifest.json`; see `fixtures.md`. Real client receipts are never committed; the benchmark tool accepts any directory with a manifest for the activation evidence.

## Exit criteria for "locally testable"

- `npm run check` green.
- Receipt benchmark agreement ≥ 90 % on the labelled set, 100 % field accuracy on qualifying receipts (gate in the tool).
- Load benchmark exactly-once true, no dead letters.
- Restore rehearsal pass.
- Browser run pass with no console errors.

## Exit criteria for "integrated client testing" (not met in this repository)

- Cloud API credentials for a test number; smoke against the real webhook; template approved for winner contact.
- Anthropic key (or acceptance of tesseract-only) and the client's real receipt sample benchmarked and accepted (`evidence.receipt_benchmark_accepted`).
- CRM sandbox reachable with the contract, or D-19 approved as post-launch.
- Client UAT script executed on real phones and signed off (`evidence.client_uat_signoff`).

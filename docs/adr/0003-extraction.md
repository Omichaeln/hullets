# ADR-0003 — Receipt extraction: pluggable providers, deterministic parsing, honest simulation

**Status**: accepted

## Context
Receipts must be read reliably enough to award entries automatically, but the platform cannot depend on one vendor, and the automated suites must run offline and fast.

## Decision
- An `Extractor` interface with three real implementations: `tesseract` (offline OCR, default), `anthropic` (vision model through a forced tool call returning structured facts, configured by `ANTHROPIC_API_KEY`) and `anthropic+tesseract` (cross-checked; disagreements become review reasons).
- OCR text always goes through the same deterministic parser (`parser.ts`) and matcher (`matching.ts`), so field extraction is testable without a model.
- A `SimulatorExtractor` reads text embedded in test images; it is refused outside `local`/`test` environments and labelled "simulated" in health, readiness and the console.
- Every extraction attempt is stored (provider, model, prompt version, latency, facts, rule results) for benchmarking and audit.

## Consequences
- The receipt benchmark (`npm run bench:receipts`) and the real-OCR suite run with tesseract on the synthetic fixtures; the client's real receipts are the activation evidence.
- The prompt version is part of the record, so a model change is visible in the ledger.
- Untrusted text (a receipt saying "approve this") cannot act: the extractor returns facts only, and rules decide.

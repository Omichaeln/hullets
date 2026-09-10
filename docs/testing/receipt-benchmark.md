# Receipt extraction benchmark

`npm run bench:receipts` runs the configured real extractor over the labelled fixtures and writes `docs/testing/evidence/receipt-benchmark.{json,md}`. Gate: disposition agreement ≥ 90 % and 100 % labelled-field accuracy on qualifying receipts. The latest run (tesseract, offline) agrees on 34/34 labelled fixtures with p50 latency under a second on this machine; see the evidence file for the table.

## Against the client's real receipts (activation evidence)

1. Collect 50–200 real receipts across all participating retailers, layouts and conditions (photographed, not scanned), with no personal data on them.
2. Label them in a manifest with the same shape as `fixtures/receipts/manifest.json`.
3. Run `EXTRACTOR=tesseract` and, if a key is available, `EXTRACTOR=anthropic+tesseract`; compare agreement, field accuracy and latency.
4. Agree the threshold with the client (recommendation: ≥ 95 % on qualified/not-qualified, everything else may fall to review) and record `evidence.receipt_benchmark_accepted` with the report reference.

The prompt/model version is stored with every extraction so a later model change is visible in the ledger.

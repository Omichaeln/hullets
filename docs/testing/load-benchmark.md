# Load benchmark

`npm run bench:load` (env `LOAD_PARTICIPANTS`, `LOAD_RECEIPTS`, `LOAD_WORKERS`) builds a throwaway database, registers participants, queues receipts and status messages without processing, then runs concurrent worker loops and reports throughput, latency percentiles, queue depth and exactly-once evidence to `docs/testing/evidence/load-benchmark.{json,md}`.

The simulated extractor and transport keep the measurement to the platform's own cost (image normalisation, fingerprints, rules, ledger, outbox). With a real extractor the per-receipt cost is dominated by OCR/vision latency (see the receipt benchmark), which scales with worker count.

Latest run: 200 receipts (10 % duplicates) and 40 status messages with 4 workers, exactly-once confirmed (180 entries for 180 distinct receipts, no dead letters). Sizing against D-21 (200 receipts/hour peak) leaves ample headroom on a single small instance even with tesseract at ~1 s per receipt.

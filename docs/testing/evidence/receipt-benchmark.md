# Receipt extraction benchmark

Generated 2026-09-10T22:50:36.682Z · extractor **tesseract** (real, tesseract.js@7.0.0)

| Metric | Value | Gate |
|---|---|---|
| Disposition agreement | 100.0% (34/34) | ≥ 90% |
| Labelled field accuracy (all) | 100.0% (57/57) | – |
| Labelled field accuracy (qualified receipts) | 100.0% | 100% |
| Latency p50 / p95 / max | 653 / 2789 / 5049 ms | – |
| Result | **PASS** | |

> Synthetic fixtures (fictional retailers and products). Agreement on client-supplied real receipts is the activation evidence (docs/testing/receipt-benchmark.md).

| Fixture | Expected | Got | Reason | No. | Date | Packs | ms |
|---|---|---|---|---|---|---|---|
| valid-two-pack-A | qualified | qualified | ok | 004512 | 2026-10-05 | 2 | 1024 |
| valid-two-pack-B | qualified | qualified | ok | 88213 | 2026-10-06 | 2 | 653 |
| valid-two-pack-C | qualified | qualified | ok | C77120 | 2026-10-07 | 2 | 660 |
| valid-two-pack-A-photo | qualified | qualified | ok | 004520 | 2026-10-08 | 2 | 1002 |
| valid-three-pack-A | qualified | qualified | ok | 004533 | 2026-10-08 | 3 | 634 |
| valid-multi-line-B | qualified | qualified | ok | 88240 | 2026-10-09 | 2 | 883 |
| one-pack-A | not_qualified | not_qualified | below_minimum | 004540 | 2026-10-09 | 1 | 630 |
| two-kg-text-not-qty-C | not_qualified | not_qualified | below_minimum | C77131 | 2026-10-09 | 1 | 648 |
| wrong-sku-A | not_qualified | not_qualified | no_qualifying_product | 004541 | 2026-10-10 | 0 | 611 |
| alt-pack-1kg-x4-B | not_qualified | not_qualified | below_minimum | 88251 | 2026-10-10 | 0 | 636 |
| void-line-A | not_qualified | not_qualified | no_qualifying_product | 004550 | 2026-10-11 | 0 | 793 |
| non-participating-outlet-A | review | review | outlet_mismatch | 1188 | 2026-10-11 | 2 | 558 |
| date-before-window-A | not_qualified | not_qualified | date_outside_window | 004311 | 2026-08-20 | 2 | 614 |
| date-after-window-A | not_qualified | not_qualified | date_outside_window | 009911 | 2027-01-05 | 2 | 643 |
| ambiguous-date-C | review | review | date_ambiguous | C77150 | 2026-06-10 | 2 | 651 |
| missing-receipt-no-B | review | review | receipt_number_unreadable | – | 2026-10-12 | 2 | 589 |
| cropped-top-A | review | review | outlet_mismatch | 004560 | 2026-10-12 | 2 | 518 |
| blurred-A | reupload / review | reupload | not_a_receipt | – | – | 0 | 1535 |
| dark-A | reupload / review | reupload | not_a_receipt | – | – | 0 | 5049 |
| random-photo | reupload | reupload | not_a_receipt | – | – | 0 | 824 |
| unrelated-paper | reupload | reupload | not_a_receipt | – | – | 0 | 2789 |
| pool-01-B | qualified | qualified | ok | 89201 | 2026-10-14 | 2 | 652 |
| pool-02-C | qualified | qualified | ok | C78102 | 2026-10-15 | 2 | 659 |
| pool-03-A | qualified | qualified | ok | 005103 | 2026-10-16 | 2 | 614 |
| pool-04-B | qualified | qualified | ok | 89204 | 2026-10-17 | 2 | 678 |
| pool-05-C | qualified | qualified | ok | C78105 | 2026-10-18 | 2 | 712 |
| pool-06-A | qualified | qualified | ok | 005106 | 2026-10-19 | 2 | 616 |
| pool-07-B | qualified | qualified | ok | 89207 | 2026-10-20 | 2 | 646 |
| pool-08-C | qualified | qualified | ok | C78108 | 2026-10-21 | 2 | 674 |
| pool-09-A | qualified | qualified | ok | 005109 | 2026-10-22 | 2 | 631 |
| pool-10-B | qualified | qualified | ok | 89210 | 2026-10-13 | 2 | 660 |
| uat-fresh-1-A | qualified | qualified | ok | 007001 | 2026-10-20 | 2 | 618 |
| uat-fresh-2-B | qualified | qualified | ok | 89701 | 2026-10-21 | 2 | 703 |
| uat-ambiguous-C | review | review | date_ambiguous | C79701 | 2026-06-11 | 2 | 674 |

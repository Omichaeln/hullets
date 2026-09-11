# Requirements traceability

FR → implementation → automated test(s). Test identifiers refer to the build prompt's T-01…T-36; suites live under `tests/`. Paths are relative to `packages/core/src` unless stated.

| FR | Requirement | Implementation | Tests |
|---|---|---|---|
| FR-01 | Registration, entry, mechanics, terms, prizes, winners, help and configured status menu | conversation/engine.ts, conversation/copy.ts | T-01, T-16 → tests/integration/journeys.test.ts |
| FR-02 | Menu as above (numbered, MENU/BACK/CANCEL/HELP/SUPPORT globals) | conversation/intent.ts, engine.ts | T-01, T-16 → journeys |
| FR-03 | Register once; recognise returning participant | participant/service.ts register(), engine registration() | T-02, T-05, T-13 → journeys |
| FR-04 | Requested registration fields and approved identity/location policy | campaign/types.ts Flags (identityStage, locationMode); participant/service.ts | T-02, T-29, T-30 → journeys, security |
| FR-05 | Versioned terms/privacy acceptance before entry | enrollments (termsVersion, privacyVersion); engine REG_TERMS | T-02, T-18, T-31 → journeys, security |
| FR-06 | Start another entry without registering again | engine startEntry(); remembered outlet for later photos | T-05 → journeys |
| FR-07 | Controlled selection from approved outlets | engine outletFlow (retailer → branch pages, search); campaign_outlets | T-03, T-11, T-17 → journeys, ocr |
| FR-08 | Receipt upload with durable acknowledgement | ops/queue.ts (persist-then-ack), receipt/pipeline.ts submit() | T-04, T-09, T-13, T-28 → ocr, reliability |
| FR-09 | Recognise receipts; reject unrelated images | extraction/parser.ts classify(); media/images.ts quality; rules document_is_receipt | T-08, T-09 → ocr (random-photo, unrelated-paper, blurred, dark) |
| FR-10 | Extract merchant, date, number, totals, lines from pixels | extraction/tesseract.ts, anthropic.ts, parser.ts | T-04, T-10, T-11 → ocr, tools/bench-receipts.ts |
| FR-11 | Deterministic product/quantity qualification | eligibility/rules.ts (packs/weight modes, integer grams) | T-10, T-11, T-18 → unit rules, ocr |
| FR-12 | Exact two-pack/4 kg interpretation | Rules.qualification (minPacks, packGrams, minTotalGrams, allowMixedPacks) | T-10 → unit rules, review suite (mixed packs) |
| FR-13 | Date/outlet/product/participant/limit checks | eligibility/rules.ts rules 3–7 | T-10, T-11, T-19 → unit, ocr, review (caps) |
| FR-14 | No repeat receipt credit anywhere in the campaign | canonical_receipts (uq_canonical_key), pipeline duplicate logic | T-06, T-07, T-12, T-14 → journeys, ocr |
| FR-15 | Exact duplicates blocked; probable duplicates reviewed | media fingerprints, duplicate_candidates, identity_conflict / ownership_dispute | T-06, T-07, T-14, T-15 → journeys, ocr, review |
| FR-16 | Multiple different qualifying receipts per participant | pipeline commit (one entry per canonical receipt) | T-05, T-12 → journeys, ocr |
| FR-17 | Correct outcome messages | conversation/copy.ts, pipeline outcome outbox rows | T-04, T-06, T-08, T-09, T-11, T-15, T-28 → journeys, reliability |
| FR-18 | One immutable award (explicit multiplier only) | entries + entry_events; Rules.award.unitsPerReceipt | T-04, T-10, T-12, T-13 → draws suite (disqualify/reinstate), ocr |
| FR-19 | Configurable own-entry count/status only | Flags.participantStatus; engine statusText() | T-16, T-29, T-32 → journeys |
| FR-20 | Mechanics, terms, prizes, approved winners accessible | engine infoText(), winnersFlow(); winner/service.ts listPublic | T-16, T-25 → journeys, draws |
| FR-21 | Winner browsing by period | engine winnersFlow; publishedPeriods | T-16, T-25 → draws |
| FR-22 | Staff configuration without code changes | campaign/service.ts versions, periods, outlets CSV import, decisions; console Campaigns | T-17, T-18 → journeys T-18, e2e |
| FR-23 | Secure human review of uncertainty | review_tasks, pipeline review/assign/escalate/correctFacts; console workspace | T-09, T-11, T-15, T-29 → review, security, e2e |
| FR-24 | Audited decisions, overrides, admin changes | audit.ts (chain, checkpoints); every service records | T-15, T-17, T-21, T-22 → security (verify), draws |
| FR-25 | Frozen qualified pool and secure random draw | draw/service.ts freeze/execute; draw/engine.ts | T-19, T-20, T-21, T-22 → unit draw-engine, draws |
| FR-26 | Controlled execution and independent approval/audit | draw approve (SoD), verifyStored, bundle, tools/verify-draw.ts | T-21, T-22, T-29 → draws, security |
| FR-27 | WhatsApp winner contact and claim lifecycle | winner/service.ts notify/transition/expireDue; outbox template gate | T-23, T-24, T-28 → draws, reliability, e2e |
| FR-28 | Only approved privacy-safe winner publication | winner publish/unpublish, listPublic (masked) | T-25, T-29, T-30 → draws |
| FR-29 | CRM participant/entry/winner/fulfilment integration | crm/index.ts mapEntity, HttpContractAdapter, outbox | T-26, T-27 → reliability (CRM receiver) |
| FR-30 | CRM/notification failures preserve accepted entries | separate outbox tables; retry/backoff; unknown_outcome handling | T-13, T-27, T-28 → reliability |
| FR-31 | Staff search, filters, reporting, permitted exports | ops/reports.ts (definitions, export), console pages | T-15, T-29, T-30, T-32 → security, review (reports) |
| FR-32 | Client-owned number/content/data/access | config (META_*), content versions, staff management, exports | T-01, T-17, T-29, T-30, T-35 → security, e2e |
| FR-33 | Versioned campaign rules, products, outlets, content, prizes | campaign_versions (configHash), decisions judged under a version | T-17, T-18, T-19 → journeys T-18, draws |
| FR-34 | Reuse and historical campaign separation | campaign clone; all ledger rows keyed by campaign | T-17, T-18, T-25, T-29 → e2e (clone), security |
| FR-35 | Real-phone client acceptance testing available | Cloud API transport + OUTBOUND_ALLOWLIST; docs/testing/client-uat.md | T-01, T-04, T-23, T-35 → blocked on credentials (see TEST_READINESS) |
| FR-36 | Delivery supports the window with explicit dependencies and honest readiness | readiness report, activation validator, docs/TEST_READINESS.md | T-34, T-35, T-36 → security T-36, restore rehearsal, e2e |

## T-xx coverage

| Test | Suite |
|---|---|
| T-01, T-02, T-03, T-05, T-06, T-07 (identity), T-13 (replay), T-16, T-18 | `tests/integration/journeys.test.ts` |
| T-29, T-30, T-31, T-36, login throttling, MFA, audit verification | `tests/integration/security.test.ts` |
| T-19, T-20, T-21, T-22, T-23, T-24, T-25, T-32 (entry disqualification), T-33 (claim expiry) | `tests/integration/draws.test.ts` |
| T-11 (extractor outage), T-13 (lease/crash, dead letters), T-26, T-27, T-28, T-29 (webhook) | `tests/integration/reliability.test.ts` |
| T-07 (ownership dispute), T-08, T-10 (caps, mixed packs), T-14, T-15, T-32 (report reconciliation) | `tests/integration/review.test.ts` |
| T-04, T-07, T-08, T-09, T-10, T-11, T-12, T-14 on real OCR | `tests/ocr/pipeline.test.ts` |
| T-33 (alert surfaces), T-34 (restore), T-35 (fresh setup, load, browser UAT), T-36 | `tools/restore-rehearsal.ts, tools/bench-load.ts, tools/e2e-console.ts, tools/preflight.ts` |

Not covered by automation in this repository (needs credentials or the client): real WhatsApp delivery and template approval (T-23, T-28 real transport), the client's real receipts (T-04 acceptance), the CRM vendor sandbox (T-26), a real phone UAT (T-35).

# ADR 0010: Evidence-first verification, with ZIMRA FDMS as the highest authority

- **Status:** accepted for implementation. **Supersedes ADR 0008** (QR-enabled fiscal-receipt fallback).
- **Date:** 19 September 2026
- **Decision owners:** Engineering and campaign operations

## Context

Two problems, one answer.

**The first is a security problem.** ADR 0008 introduced a QR fallback that fired when OCR was incomplete, fetched whatever HTTPS URL the code contained, and merged the response into the receipt's facts. `QR_ALLOWED_HOSTS` defaulted to empty, which the implementation read as "any public host". When OCR read nothing — the exact condition that triggered the fallback — the fetched document became the sole source for merchant, date, receipt number and line items, and a flag set by that same fetch suppressed the low-OCR-confidence review trigger. A printable QR code pointing at an attacker's own endpoint could therefore dictate every fact an entry was judged on, and mint a fresh receipt identity each time so duplicate prevention never engaged. ADR 0008 asserts the fallback "cannot override campaign dates, participating-outlet rules, product qualification, receipt identity, duplicate prevention, caps". That was true only in the sense that it did not replace a value OCR had read; it was not true when OCR read nothing.

**The second is a quality and cost problem.** OCR was the first and only reading of every receipt, so the accuracy of the whole promotion was the accuracy of a camera phone in a shop doorway. Uncertainty had exactly one outlet: a human. At national volume that makes verification staff scale with transactions.

Zimbabwe's fiscal receipts carry a QR code that resolves to the revenue authority's own record of the transaction. That record is not a better reading of the paper — it is what the till actually transmitted. Used correctly it is both a stronger source than OCR and a stronger duplicate key than anything derived from the image.

## Decision

Verification becomes an **evidence ledger** rather than a pipeline of overrides.

### 1. Sources are ranked, and never collapsed

```
ZIMRA FDMS (100) > receipt image (60) > OCR (40) > AI (30) > participant (20)
```

Every source's assertion about every field is recorded. The ledger answers three questions separately: what is believed (the highest-authority assertion), how well it is supported (which lower sources agree), and what disagrees (which conflict, and whether that conflict is material). **A lower-authority source can never overwrite a higher one, but it can contradict it, and a contradiction is a finding rather than a value to discard.**

### 2. The QR code is an identifier, never a source of facts

A decoded code is parsed for the identifiers it carries — device id, fiscal day, receipt global number, verification code — and those are looked up against a **configured, allowlisted** validation endpoint. Nothing is fetched from wherever the code points. `FISCAL_ALLOWED_HOSTS` is mandatory: empty means fiscal verification is not configured and every receipt takes the OCR path. It never means "any host". Configuration validation refuses a `zimra-fdms` provider without both a base URL and an allowlist containing that URL's host.

The hardened fetch (HTTPS only, port 443, no credentials, private-range checks on every resolved address, connection pinned to the resolved address with the original SNI and Host header, byte and redirect caps, every hop revalidated) is retained from ADR 0008 and moved to `util/safe-fetch.ts`, with `requireAllowlist` defaulting to refuse.

### 3. The image still matters, and is still read

OCR and the model run whether or not the authority answered. When it did, their job is no longer to establish the facts but to establish that **the document the participant photographed is the transaction the authority confirmed**. Where they disagree materially, the entry does not qualify automatically.

### 4. The decision is a function of evidence, not a self-reported score

A model stating "98% confident" is a number with no denominator. `decideTier()` is a pure function over: which sources asserted what, whether they agree, whether the deterministic campaign rules passed, what the duplicate checks found, and what the model flagged. The model's assessment is one input and **can only ever withhold qualification, never grant it**.

| Tier | Condition | Outcome |
|---|---|---|
| 1 | Authority confirmed, image agrees, rules satisfied | Qualify |
| 2 | Authority confirmed, image or data disagrees materially | Review |
| 3 | No authority, consistent image evidence, rules satisfied | Qualify if risk allows |
| 4 | A required field established by nothing | Ask the participant |
| 5 | Conflicts, anomalies, a model hold, or a participant dispute | Review |
| 6 | Already credited, authority refused, or a rule failed outright | Duplicate / reject |

### 5. The participant confirms; they do not do data entry

Entering the promotion goes straight to capture. The shop, date, amount and product are established from the evidence, and the participant is asked only for what nothing could establish — and then only for that one field. Their answer enters the ledger at the lowest authority and is reconciled; it is never assumed. A participant contradicting an established value is a finding that reaches a human, not an input to reconcile away.

A question that goes unanswered past the review SLA, or that cannot be asked because the participant is mid-conversation elsewhere, escalates to a reviewer. Nothing sits in a state nobody is looking at.

### 6. Duplicate detection keys on the strongest identifier available

Where a fiscal record exists, the canonical receipt key is `zimra:<device>:<fiscalDay>:<globalNo>` — one transaction at one till, independent of how well the paper photographed. Otherwise the existing `outlet|date|receiptNo` key applies, with the outlet now read from the document rather than declared by the participant.

Duplicate evidence is split by whether the other submission actually **holds** the award. A byte-identical or fiscally identical submission that was credited is a duplicate; one that exists but was never credited is a re-upload, a retry, or two people photographing the same slip, and raises risk rather than rejecting.

### 7. Human decisions are captured as calibration data

Every automated decision is written to `verification_outcomes` with its tier, authority, risks and discrepancies. When a reviewer later decides, the row records the agreement and its direction. This is an **offline evaluation set**: nothing reads it back into a live decision and nothing retrains from it. Its purpose is to make "the model said qualify and a reviewer disagreed" countable by tier and by evidence source, so a proposed change has something to be measured against before it ships.

## Consequences

### Positive

- The fraud path ADR 0008 opened is closed at the design level, not patched: a QR code can no longer supply a single fact.
- Receipts carrying a fiscal code are verified against the authority's own record, which is both more accurate than OCR and a far stronger duplicate key.
- The participant experience is capture-then-confirm rather than navigate-then-capture.
- Uncertainty has a cheaper resolution than a human for the common case (a missing field the participant can supply).
- The reviewer receives the whole evidence chain with each value's source named, instead of reconstructing the transaction.

### Costs and risks

- **The FDMS contract is not verified.** The QR layout and the validation endpoint shape were implemented without access to ZIMRA's published specification or a test device. Both are configuration (`FISCAL_QR_LAYOUT`, `FISCAL_BASE_URL`) and the adapter is one class. **They must be confirmed against the real specification before this path is trusted in production** — a wrong QR width mis-identifies every receipt, and the parser deliberately refuses a tail whose numeric groups are not numeric rather than producing a silently misaligned identity.
- An outbound dependency on a third party in the receipt path. Its failure degrades to the OCR path rather than stopping intake; `FISCAL_REQUIRED=false` is the default for that reason.
- The evidence ledger is more code than a pipeline of overrides, and the reviewer surface carries more information.
- Establishing an outlet from a receipt header now needs a stronger match (0.8) than merely corroborating one (the campaign's `outletMatch.minScore`, 0.5). A receipt that mentions only a town no longer names a branch; it asks.

## Rollout and rollback

1. Deploy with `FISCAL_PROVIDER=none`. Everything takes the OCR path; behaviour matches the previous release except that the QR fetch no longer exists.
2. Confirm the QR layout and the validation endpoint against ZIMRA's specification and a real fiscal receipt. Adjust `FISCAL_QR_LAYOUT` and the adapter's request shape.
3. In staging, set `FISCAL_PROVIDER=zimra-fdms`, `FISCAL_BASE_URL` and `FISCAL_ALLOWED_HOSTS`. Verify a real receipt end to end and inspect the stored `fiscal_verifications` row.
4. Enable in production for a bounded observation window. Watch the `fiscal.verification` metric by status, the tier distribution, review rate and the discrepancy counts in `verification_outcomes`.
5. Roll back with `FISCAL_PROVIDER=none`. Configuration only; no database rollback. Existing verifications remain auditable.

## Not covered

This does not authorize sending real campaign traffic, changing Meta phone numbers, or declaring production readiness. The soak test ADR 0007 requires — real receipts at 2–3× expected peak, with real OCR — has still not been done, and every throughput number in this repository remains simulated or micro-benchmarked.

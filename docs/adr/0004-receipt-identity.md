# ADR-0004 — One purchase, one award: canonical receipt identity

**Status**: accepted · relates to D-05/D-06

## Context
Participants re-photograph, crop, rotate and re-send receipts; two people may send the same receipt; a bad read may lose the total. The platform must award exactly once per purchase without punishing honest re-uploads.

## Decision
- Canonical key = selected outlet + transaction date + normalised receipt number. The total is stored on the canonical receipt as a **conflict check**: a different readable total for the same key is an `identity_conflict` sent to review, never a second award.
- Image fingerprints (sha256, aHash, dHash) find re-photographs and recompressions as duplicate candidates independently of OCR.
- If the key is incomplete (no number or date), the submission goes to review; a reviewer corrects the facts before qualification; the key is built from the corrected facts.
- Same key from the same participant links the new photo as a re-upload of the first attempt; from a different participant while the first is undecided, it is an `ownership_dispute` for the reviewer with a candidate row linking both.
- The commit inserts the canonical receipt and the entry in one transaction under unique constraints (`uq_canonical_key`, `uq_entry_canonical`), so concurrent submissions of the same purchase resolve to one award.

## Consequences
- Duplicates are explainable to participants without leaking who sent the original.
- Reviewers see the candidates and resolve them explicitly; resolutions are audited.

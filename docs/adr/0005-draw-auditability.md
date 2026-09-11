# ADR-0005 — Auditable draws: committed seed, deterministic sortition, independent verifier

**Status**: accepted

## Context
A prize draw must be provably fair after the fact to the client, the regulator and a sceptical participant, without trusting the operator.

## Decision
- **Barrier** before freezing: period ended, no unresolved submissions (overridable with a documented reason), no live draw, a prize plan, enough candidates.
- **Freeze** snapshots the candidate list (entry ids, participant ids, units), exclusions and the plan; generates a CSPRNG seed and stores its SHA-256 **commitment** in the snapshot. The snapshot hash is recorded and audited.
- **Execute** computes an HMAC-SHA256 score per chance (`chance:<entryId>:<unit>`) with the seed as key, sorts, and selects winners then alternates honouring one-prize-per-participant. Execution is reserved durably, idempotent and resumable.
- **Approve** requires a different person from the officer/executor, re-runs the integrity check (snapshot hash, seed commitment, candidate rows, output hash) and pins the output hash the approver looked at.
- **Bundle** exports everything needed to recompute the draw (seed only after execution); `tools/verify-draw.ts` recomputes it without the application and checks the audit checkpoint signature when given the key.
- **Void + re-run** needs a second approver, keeps the voided evidence, replaces uncollected winners and links the replacement draw.

## Consequences
- Anyone with the bundle can verify the result; the operator cannot change the candidate list or the seed after freezing without detection.
- Randomness is withheld until execution so a frozen draw cannot be "previewed".

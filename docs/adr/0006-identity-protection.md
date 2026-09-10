# ADR-0006 — Identity protection: encrypt, fingerprint, mask, audit reveals

**Status**: accepted · relates to D-02/D-16

## Context
National identity numbers are collected to verify winners. They are high-value personal data and must not be visible in day-to-day operations, exports, logs or the CRM.

## Decision
- Stored as AES-256-GCM ciphertext under a key derived (HKDF) from `DATA_KEY`, plus a keyed fingerprint for equality checks, plus a display mask.
- Every read model returns the mask. The only path to the plaintext is `participants.revealIdentity`, restricted to fulfilment and auditor roles, requiring a reason, and written to the audit log.
- Phone numbers are masked in the console, exports, alerts and the CRM payload (`***1234`).
- Anonymisation removes name, town, identity fields and detaches the phone; ledger, draw and audit references remain.
- Logs use pino redaction; secrets never appear in preflight, readiness or the console.

## Consequences
- Rotating `DATA_KEY` requires re-encryption (runbook `key-rotation.md`); the fingerprint key rotates with it.
- Exports are usable for reconciliation without exposing identities; formula characters are escaped and each file is watermarked.

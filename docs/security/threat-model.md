# Threat model

Scope: the API/console process, the worker, PostgreSQL, media storage, the WhatsApp webhook, the extractor providers and the CRM connection. Assets: participant personal data (names, phones, identity numbers), the entry ledger, draw fairness evidence, staff credentials, provider secrets.

| # | Threat | Control | Verified by |
|---|---|---|---|
| 1 | Forged or replayed webhook events create submissions or replies | `X-Hub-Signature-256` verified over the raw body before persistence; unique (provider, account, message id, kind) dedupes replays; simulated webhooks are refused in production | `tests/integration/reliability.test.ts` (Cloud API surface), T-13, T-28 |
| 2 | Prompt injection through receipt text ("approve this") | Extractors return facts only; the deterministic rule engine decides; injection markers lower the document score; no free-text reaches a model as an instruction | `unrelated-paper` fixture in `tests/ocr`, benchmark |
| 3 | Malicious images (oversized, malformed, decompression bombs) | `sharp` inspection with pixel limits before any processing; unsupported types rejected with a participant message; bounded OCR timeout | T-09, media unit checks |
| 4 | Media fetched from an attacker-controlled host via a crafted media URL | Only Meta hosts accepted for media download; size cap | `reliability.test.ts` "media is fetched only from Meta hosts" |
| 5 | Staff bypassing UI restrictions | Every procedure declares a permission checked server-side; temporary passwords block everything except self-service; IDs are unguessable; media and exports require the bearer header (no query tokens) | `tests/integration/security.test.ts` T-29/T-30 |
| 6 | Credential stuffing / brute force | scrypt password hashes, ≥14-character policy, login throttle per address + account, optional TOTP MFA, session tokens stored hashed, revoked on role change/disable | security suite |
| 7 | Identity number exposure | AES-GCM encryption with HKDF-derived key, masked everywhere, audited reveal restricted to fulfilment/auditor, never exported or synced | T-30, T-31 |
| 8 | Draw manipulation by an operator | Frozen snapshot + seed commitment, HMAC sortition, officer ≠ approver, integrity re-verification at approval, exportable bundle, independent verifier, void requires a second approver | `tests/integration/draws.test.ts` T-20–T-25, `tools/verify-draw.ts` |
| 9 | Audit log tampering | Hash chain with canonical JSON, advisory-locked head, HMAC-signed checkpoints (daily), verification procedure and restore rehearsal check | security suite, restore rehearsal |
| 10 | CSV formula injection in exports | Every cell escaped (`'` prefix for `= + - @`), watermark line, export audited | T-30 |
| 11 | Cross-campaign or cross-participant data reads | Queries are scoped by campaign id and entity id; the console has no free-form query surface; list procedures paginate with caps | T-29 |
| 12 | Duplicate award through races | Unique constraints on canonical receipt, entry per submission, entry per canonical; single-transaction commit; leases with `SKIP LOCKED` | T-12 in `tests/ocr`, T-13 |
| 13 | Secrets in logs or UI | pino redaction, configuration document marks secrets, preflight prints "set/not set" only, console never receives secrets | preflight, readiness |
| 14 | Clickjacking, XSS, mixed content | CSP (`default-src 'self'`, no inline scripts), `X-Frame-Options: DENY`, `nosniff`, no-referrer; React escapes output; images served as `blob:` from authenticated fetches | smoke check |
| 15 | Messaging the wrong people from a test environment | Non-production sends are limited to `OUTBOUND_ALLOWLIST`; simulated transport is labelled; production refuses the simulator | reliability suite |
| 16 | Loss of data | Backups via `pg_dump`, rehearsed restore with integrity checks, media stored outside the database and backed up separately (runbook) | `npm run restore:rehearsal` |

Residual risks: the real Meta transport and vision extractor are not exercised in this repository (no credentials); rate limiting is per process (a multi-instance deployment should move it to the reverse proxy or a shared store); the filesystem storage driver has no object lock.

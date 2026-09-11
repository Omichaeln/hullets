# Data lifecycle

| Data | Where | Protection | Retention / deletion |
|---|---|---|---|
| Phone number (channel identity) | `participants.channel_uid`, `inbound_events`, `outbound_messages` | masked in console, exports, alerts, CRM (`***1234`) | anonymisation replaces the participant's uid with `deleted:<id>`; message rows keep the uid for delivery reconciliation until purged with the campaign archive |
| Name, town | `participants` | plain (needed for winner contact); masked name in public winner listing | removed at anonymisation |
| Identity number | `participants.identity_enc` (AES-256-GCM), `identity_fp` (keyed hash), `identity_mask` | encrypted at rest; reveal audited and role-limited; never exported or synced | removed at anonymisation |
| Consent (terms/privacy versions, marketing) | `enrollments` | versions captured at acceptance; new versions apply prospectively | kept as evidence; withdrawal timestamp recorded |
| Receipt images | media storage (`MEDIA_ROOT` or S3), `media_assets` | authenticated download only, audited view, fingerprints kept | purged after `RETENTION_MEDIA_DAYS` (housekeeping job); ledger keeps hashes and facts |
| OCR text and facts | `extractions` | shown only to roles with media rights | kept with the ledger |
| Ledger (submissions, canonical receipts, entries, draws, winners) | PostgreSQL | append-only semantics; corrections are events | kept for the campaign's statutory period; campaign archive is the unit of deletion |
| Audit log | `audit_events`, `audit_checkpoints` | hash chain + signed checkpoints | never deleted |
| Staff credentials | `staff_users` (scrypt), `staff_sessions` (hashed tokens), MFA secret (encrypted) | sessions expire (`SESSION_HOURS`), revoked on role change/disable | disabled users retain audit attribution |
| CRM payloads | `crm_events` (masked canonical records) | no identity numbers or full phones | kept for reconciliation; the vendor's retention is a client decision (D-22) |
| Backups | `pg_dump` custom format | encrypt at rest where stored; restore rehearsed | per the client's retention policy |

Participant rights: **correction** (support role, audited reason, CRM updated), **withdrawal** (stops participation, keeps ledger), **deletion** (anonymise: personal fields removed, ledger references remain), all in the console under Participants. Exports never contain identity numbers or full phone numbers.

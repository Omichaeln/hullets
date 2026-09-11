# Architecture

## Shape

A single TypeScript codebase deployed as one API process (with an embedded worker loop) or as API + separate worker processes, in front of one PostgreSQL database and an object store for receipt images (filesystem driver in this checkout; the storage interface is the seam for S3-compatible storage).

```
WhatsApp (Meta Cloud API) ──webhook──▶ apps/api ── persist event ──▶ inbound_events (queue)
                                                                         │ lease (FOR UPDATE SKIP LOCKED)
                                                              worker ────┤
                                                                         ▼
                              conversation engine ──▶ receipt pipeline ──▶ ledger (submissions, canonical_receipts, entries)
                                       │                     │                     │
                                       ▼                     ▼                     ▼
                                 outbound_messages      review_tasks           draws / winners
                                       │ dispatch                                 │
                                       ▼                                          ▼
                                   transport                                 crm_events ──▶ CRM
```

Everything the staff console does goes through tRPC procedures guarded by a central permission policy; the same domain services serve the worker, the API, the tools and the tests.

## Modules (`packages/core/src`)

| Module | Responsibility | Key invariants |
|---|---|---|
| `auth` | staff users, scrypt passwords, bearer sessions (hashed tokens), TOTP MFA, roles → permissions | permissions are enforced server-side in `apps/api/src/trpc.ts`; a temporary password blocks everything but self-service |
| `audit` | append-only, hash-chained events; HMAC-signed checkpoints | `prev_hash` chain verified by `audit.verify`; a checkpoint is signed daily by housekeeping |
| `campaign` | campaigns, versioned rules/content/flags/prize plans, periods, decisions, controls, outlets, products | one active version (partial unique index); a drawn period is immutable; activation validator |
| `participant` | registration, masked identity (AES-GCM + keyed fingerprint), corrections, withdrawal, anonymisation, phone change | identity number never leaves the service unmasked except through the audited reveal |
| `conversation` | WhatsApp state machine (menu, registration, outlet, receipt, winners, support) | optimistic versioning per conversation; support hand-off suspends automation |
| `media` | image validation, normalisation, fingerprints (sha256, aHash, dHash), quality metrics, retention purge | rejected images never reach the extractor |
| `extraction` | tesseract (offline), Anthropic vision (forced tool call), cross-checked composite, simulator (test only), deterministic parser, outlet/product matching | the simulator is refused outside local/test |
| `eligibility` | typed rules → disposition with per-rule results | integer grams; document/quality failures → re-upload; unknowns → review; caps only when approved |
| `receipt` | intake → process → decide → commit; review actions; reprocess; disqualify/reinstate | canonical key `outlet|date|receiptNo`; the total is a conflict check; award in the same transaction as the decision, audit, outbox and CRM event |
| `draw` | barrier, freeze (snapshot + seed commitment), execute (HMAC sortition), approve/reject, publish, void + re-run, bundle, verify | advisory locks serialise freeze; officer ≠ approver; execution is a durable reservation |
| `winner` | materialise, notify (claim token), transitions, collection, expiry, alternates, publication, public projection | `TRANSITIONS` map; one prize per participant; publication is a separate axis |
| `crm` | canonical mapping (`crm-map/1`), versioned outbox, delivery with read-back, reconciliation | stale versions never overwrite; unknown outcomes are reconciled, not re-sent blindly |
| `whatsapp` | Cloud API transport (handshake, signature, normalisation, Meta-host-only media, templates) and simulator transport | unsigned webhooks are rejected before persistence |
| `ops` | queue (events, jobs), outbox, alerts/metrics, reports, activation validator, worker, observability (health samples once a minute, redacted and fingerprinted error log) | exactly-once processing through leases + unique keys; error messages are redacted before storage and recording a failure never throws into the failure it describes |

## Data flow for a receipt

1. Webhook persists the normalised event (unique per provider/account/message/kind) and acknowledges. Replays are deduplicated.
2. The worker leases the event, runs the conversation engine; in the receipt state the image is stored (validated, normalised, fingerprinted) and a `submission` is created with a participant-facing reference; a `submission.process` job is enqueued; an acknowledgement is queued in the outbox.
3. The job extracts facts, evaluates the rules, checks duplicates (exact bytes, perceptual hashes, canonical key), and commits the decision, the entry (if awarded), the audit event, the outcome message and the CRM event in one transaction with an optimistic version check.
4. Transient extractor failures leave the submission `delayed` with a participant notice and a scheduled retry; after six attempts an alert is raised.

## State machines

- **Submission**: `received → processing → {qualified | not_qualified | duplicate | reupload | review | delayed}`; `review → {qualified | not_qualified | duplicate | reupload}` by a reviewer; `delayed → processing` on retry; any non-credited status can be reprocessed (`→ received`).
- **Entry**: `active ⇄ excluded` via disqualify/reinstate events (the award row is never deleted).
- **Draw**: `frozen → executing → executed → approved → published`; `executed → voided` (reject); `approved|published → voided` (void + re-run, second approver) with a linked replacement draw.
- **Winner**: see `packages/core/src/winner/transitions.ts`. Publication: `unpublished → published → withdrawn`.
- **Campaign**: `draft → active ⇄ paused → closed → archived`.

## Concurrency and exactly-once

- Inbound events and jobs are leased with `FOR UPDATE SKIP LOCKED`; a crashed worker's lease expires and the item is retried; attempts are counted and dead-lettered after the limit.
- Unique constraints back every "once": one submission per provider message, one entry per submission, one entry per canonical receipt, one outbox row per idempotency key, one draw per period unless voided, one winner per draw+entry.
- The draw freeze takes an advisory lock so barrier and snapshot are one consistent read; the audit chain head is written under an advisory lock so hashes never fork.

## Configuration

`packages/core/src/config.ts` is the single source: a documented schema (`CONFIG_DOC`) that also generates `.env.example`, validation per environment (`validateConfig`), and `.env` loading for local runs. Production refuses simulated providers and requires the secrets.

## Deployment shape

One container image; `npm start` (API + embedded worker) or `npm start` with `WORKER_MODE=external` plus `npm run worker`. PostgreSQL managed; storage volume or S3 (driver seam); reverse proxy terminating TLS; Meta webhook pointed at `/webhooks/whatsapp`. See `docs/runbooks/deploy.md`.

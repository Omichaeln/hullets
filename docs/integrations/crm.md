# CRM integration

No vendor is selected (D-19). The platform implements a **generic HTTP contract** so a vendor adapter is a thin mapping, and ships a local receiver (`npm run crm:receiver`) that implements the contract with fault injection for tests.

Contract (`CRM_PROVIDER=http-contract`, `CRM_BASE_URL`, `CRM_TOKEN`, `CRM_TIMEOUT_MS`):

- `PUT /records/:type/:externalKey` with `{ entity_version, record }` → `200 { id }`; a lower version than stored → `409`.
- `GET /records/:type/:externalKey` → the stored record with `entity_version` (read-back confirmation).
- `GET /health`.

Canonical mapping `crm-map/1` (`packages/core/src/crm/index.ts mapEntity`): participant (masked phone), enrollment (consent versions), submission, entry, winner, claim. Keys are `<environment>:<type>:<id>` so test and production never collide. Identity numbers and full phone numbers are never sent.

Delivery: an outbox row per entity version; the worker leases, writes, reads back and marks `delivered` only when the vendor returns the written version. Timeouts after a write become `unknown_outcome`; `reconcile` compares with the vendor and either confirms or requeues. Stale versions are marked superseded rather than sent. Retries back off; operators can retry or reconcile from Ops → CRM sync. Entries are never affected by CRM state.

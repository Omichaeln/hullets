# ADR-0002 — PostgreSQL instead of the house default (MySQL/TiDB)

**Status**: accepted (deviation from PointFive defaults, stated explicitly)

## Context
The house stack defaults to MySQL/TiDB with Drizzle. This system's correctness rests on a few database features used heavily: partial unique indexes (one active version, one live draw per period), `FOR UPDATE SKIP LOCKED` queue leasing, transactional advisory locks for the audit chain head and draw freeze, and `jsonb` for versioned rules and facts.

## Decision
PostgreSQL 16. Drizzle keeps the query layer portable, but the schema deliberately uses the features above rather than emulating them.

## Consequences
- Partial unique indexes and advisory locks give exactly-once and "one live draw" guarantees as constraints, not application checks.
- MySQL/TiDB would need surrogate uniqueness columns, a lock table and application-level serialisation for the audit chain; TiDB in particular does not support advisory locks or `SKIP LOCKED` in the same way.
- Operationally PostgreSQL is a managed service everywhere the platform is likely to be hosted; `pg_dump`/`pg_restore` back the restore rehearsal.
- If the client mandates MySQL/TiDB, the migration cost is concentrated in `packages/db/src/schema.ts`, `ops/queue.ts`, `audit.ts` and `draw/service.ts`.

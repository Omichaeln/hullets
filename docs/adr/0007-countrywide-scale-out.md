# ADR 0007: Countrywide campaign scale-out

- **Status:** accepted for implementation
- **Date:** 2026-09-17
- **Decision owners:** Engineering and campaign operations

## Context

The Railway staging assessment showed that lightweight API reads remained broadly healthy at approximately 200–220 requests per second, while the single embedded worker accumulated inbound backlog during a sustained signed-webhook test. Receipt processing is the material bottleneck: real Tesseract processing measured 681 ms p50, 3,459 ms p95, and 6,331 ms maximum on the repository fixture set. The current filesystem media driver is not durable enough to be the production source of truth for a nationwide campaign.

## Options considered

1. **Keep the embedded worker and increase the API replica count.** Rejected: every API replica would independently run a worker, making CPU, OCR, and provider traffic compete with HTTP work. It also makes worker throughput and outbound rate control harder to reason about.
2. **Split into API and external worker services while keeping PostgreSQL as the durable queue.** Chosen: the queue already uses leases and `SKIP LOCKED`, and the worker entrypoint already exists. API and worker capacity can be changed independently while retaining one modular monolith and one database.
3. **Introduce a new hosted queue immediately.** Deferred: a managed queue would add operational and data-reconciliation cost. PostgreSQL leasing is sufficient for the first scale-out step if queue age, dead letters, and connection saturation are monitored.

## Decision

Deploy the application as separate Railway services:

- **API service:** HTTP/webhook/console only; `WORKER_MODE=external` or `off` and a bounded `HTTP_MAX_IN_FLIGHT` admission limit.
- **Worker service:** `npm run worker`, initially two replicas, with `WORKER_MODE=external`; workers claim leased queue rows concurrently using the existing database semantics.
- **PostgreSQL:** managed Railway Postgres, with independent pool sizing and connection/statement timeouts for each service.
- **Media:** S3-compatible object storage (`STORAGE_DRIVER=s3`) with server-side encryption, a private bucket, a media prefix, and lifecycle retention matching campaign policy.

The API returns a fast retryable overload response when its per-replica admission budget is exhausted. Webhook persistence remains durable-then-acknowledge, and consumers remain at-least-once/idempotent.

## Consequences

### Positive

- Receipt OCR and provider calls no longer consume API request capacity.
- Worker replicas can be increased independently as queue age grows.
- API overload fails fast with retryable 429/503 responses instead of timeout cascades.
- Media survives API/worker redeploys and can be backed up independently.
- Database pool and timeout settings become explicit per service.

### Costs and risks

- Two independently deployed services require coordinated configuration and runbooks.
- PostgreSQL remains the queue coordination point; it must be monitored and sized.
- Multiple workers require idempotent consumers and careful per-participant ordering. Existing lease/idempotency constraints remain mandatory.
- S3 introduces credentials, lifecycle policy, and restore testing obligations.
- This ADR does not by itself certify countrywide capacity. A production-like receipt soak at 2–3× expected peak remains required.

## Rollout and rollback

1. Ship code with the worker entrypoint, S3 driver, admission control, and configurable pools. Keep API `WORKER_MODE=embedded` until the worker service is healthy.
2. Provision the private S3 bucket and verify a put/get/delete health probe from staging.
3. Add the Railway worker service with `npm run worker`, external mode, and one replica. Verify queue drain and no duplicate processing.
4. Scale the worker to two replicas and observe queue age, OCR latency, outbound outcomes, and DB pool saturation.
5. Set API `WORKER_MODE=external` and redeploy the API. Keep the old embedded mode available as a rollback switch.
6. Roll back by setting API `WORKER_MODE=embedded` and reducing worker replicas to zero only after confirming the API is healthy. Never run embedded workers and external workers simultaneously for normal operation.

Rollback criteria: API 5xx > 2% for 5 minutes, webhook p95 > 1 second for 5 minutes, queue oldest age > 5 minutes without decreasing for 10 minutes, duplicate-processing evidence, or any data-integrity alert.

## Not covered

This decision does not authorize changing Meta phone numbers, sending real campaign traffic, deleting staging data, or declaring production readiness. Those remain separate operational approvals.

# Worker scale-out and queue backlog

## Signals

Watch these metrics and alerts:

- `inbound.backlog`: oldest inbound event is older than five minutes.
- Queue depth by state: received, processing, dead-lettered.
- Job depth and oldest job age.
- Receipt extraction p95/max latency.
- Database pool wait/errors and Railway Postgres CPU/connections.
- Outbound `unknown_outcome` and `permanent_failure` counts.
- API 5xx, 429/503 load-shed responses, webhook p95 latency.

## Normal topology

The API handles HTTP, webhooks, the console, and authenticated media. The worker service runs `npm run worker` with `WORKER_MODE=external`. Do not run the API with `WORKER_MODE=embedded` while external workers are processing the same production queue except during a controlled rollback.

## Scale up

1. Confirm the backlog is real and not only a metrics delay: inspect `ops.queues` and the oldest event/job.
2. Check Postgres connections and CPU before adding workers. If the database is saturated, adding workers will amplify the incident; increase database capacity or reduce batch sizes first.
3. Increase the worker replica count by one. Keep `WORKER_EVENT_BATCH` and `WORKER_JOB_BATCH` bounded.
4. Observe for 10 minutes: queue oldest age must decrease, dead letters must remain flat, and Postgres connection errors must remain zero.
5. Repeat one replica at a time. Stop when queue age is falling and database saturation approaches the agreed operating threshold.

## Scale down

Reduce one worker replica at a time after the queue has drained. A worker lease expires safely if a replica is terminated. Do not delete queue rows to reduce visible backlog.

## Failure handling

- **Storage unavailable:** pause intake or disable receipt-processing release, repair S3 credentials/endpoint, then retry affected jobs. Do not switch production back to ephemeral filesystem storage.
- **Extractor slow/outage:** keep webhook acknowledgements durable, cap job concurrency, and let the queue absorb a bounded backlog. Use the receipt review/reupload path for dead letters.
- **Provider outage:** pause outbound at campaign controls if necessary. Unknown outcomes must not be blindly resent; reconcile provider status first.
- **Dead letters:** inspect error, event id, job id, and correlation id; fix the cause; replay through the console so the action is audited.

## Rollback

If the external worker release causes data-integrity errors or API instability:

1. Stop external worker replicas after recording queue depth and oldest age.
2. Confirm the API is healthy and has the intended rollback commit.
3. Set API `WORKER_MODE=embedded` only for the controlled recovery window.
4. Monitor the queue and API saturation closely; embedded mode is a fallback, not the countrywide operating mode.
5. Restore external workers after the corrected release passes staging and a production-like soak.

Never combine a database schema rollback with an application rollback unless the migration runbook explicitly verifies compatibility.

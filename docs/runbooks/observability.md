# Observability: uptime, throughput and the error log

Where to look when something is wrong, and what each signal means. Everything below is in the console under **Integrations & queues** (permission `ops.read`: platform admin, campaign manager, auditor, support), with the headline figures repeated on the Overview.

## Uptime & throughput

The worker's housekeeping writes a **health sample once a minute** (table `health_samples`, 30 days retained): the dependency checks (transport, extractor, storage), backlog gauges (waiting events and jobs, dead letters, outbound failures, reviews past target), counters since the previous sample (inbound messages, processed, sent, errors), tick lag and process memory. Several processes may sample; each is named `host:pid`.

**Availability** is computed from the samples, not asserted by the application. A sample vouches for its status until the next one, for at most 2.5 minutes. Time without samples beyond that is **not reporting** (the process is down, the worker is stalled or the database is unreachable). A sample with a failing check is **degraded** until the next healthy one. The window starts at the first sample inside it, so a service deployed yesterday is not charged for the days before. The strip shows one cell per bucket (green healthy, amber `!` degraded, red `×` down, grey no samples); the gaps table lists every interruption with its duration and whether it is ongoing.

Reading the charts:

| Chart | Healthy | Investigate when |
|---|---|---|
| Inbound received / messages sent | tracks campaign activity | inbound stops during a live campaign (webhook, Meta side, `provider-outage.md`) |
| Errors recorded | zero or sporadic | a step change: open the error log, the fingerprint tells you what |
| Work waiting (peak) | returns to zero within a minute or two | grows steadily: worker not running, or a poisoned event (`queue-replay.md`) |
| Dead letters and outbound failures outstanding | zero | anything: replay or retry from Queues / Outbound messages |
| Reviews past target | zero | rising: staffing, or raise the SLA setting deliberately (`review-operations.md`) |
| Worker tick lag (peak) | under a few seconds | tens of seconds: the process is starved or the database is slow |
| Process memory | flat | climbing without end: restart and report |

Health samples also feed the Overview tiles (availability 24 h, errors 24 h, inbound 24 h, waiting now).

## Error log

Every failure the platform handled is written to `error_events` (90 days retained), redacted before insert: phone numbers become `***1234`, e-mail addresses `[email]`, tokens `[redacted]`, deep file paths `[path]`; there is never a stack trace, SQL or message body. Each row carries a **fingerprint** (source, code, where, and the message with identifiers and numbers normalised), so one root cause is one line in the summary however often it fires.

| Source | What it is | Typical codes |
|---|---|---|
| `trpc` | an API call failed with an internal error (the caller saw only "internal error") or a dependency was unavailable | `INTERNAL`, `UNAVAILABLE`, driver codes such as `ECONNRESET` |
| `http` | a non-API HTTP failure (media, exports, bundle download) | `INTERNAL`, `PAYLOAD_TOO_LARGE` |
| `webhook` | a provider webhook was rejected or could not be persisted | `BAD_SIGNATURE` (forged or misconfigured app secret), `INTAKE_UNAVAILABLE` |
| `worker.event` | an inbound message failed processing | `EVENT_FAILED` (will retry), `EVENT_DEAD_LETTER` (needs replay) |
| `worker.job` | a background job failed | `JOB_FAILED`, `JOB_DEAD_LETTER` |
| `worker.outbound` | a message could not be sent and will not be retried automatically | provider error codes, `PERMANENT_FAILURE`, `UNKNOWN_OUTCOME` |
| `worker.tick`, `housekeeping` | the worker loop itself failed | `TICK_FAILED`, `HOUSEKEEPING_FAILED` |
| `console` | the staff console crashed in a browser (render error, unhandled rejection, script error) | `RENDER_ERROR`, `UNHANDLED_REJECTION`, `SCRIPT_ERROR` |

Each occurrence keeps its **correlation id** (the same id is in the request log and the audit log) and **references** (submission, event, job, outbound message) that open the record concerned. **Resolve** (permission `ops.alerts.ack`) closes one occurrence or every open occurrence of a fingerprint with a note; the note is written to the audit log as `error.resolve`. Resolving does not delete anything: use *Unresolved only* to work the list down, untick it to see history.

Errors are not alerts. Alerts (the Alerts tab) are raised for conditions that need a person now and are de-duplicated per kind; the error log is the complete record. A dead letter produces both.

## Working an incident from here

1. Overview tile red or availability below target: open **Uptime & throughput**, read the gaps table (not reporting versus degraded), then the latest checks badges.
2. Open **Error log**, *Unresolved only*, last 24 h; the top fingerprint by count is usually the cause. Use the correlation id to find the request in the Railway log stream if you need the full context.
3. Fix, replay or retry as the relevant runbook describes; then resolve the fingerprint with a note saying what was done. The note is the incident record.
4. If the console itself misbehaves for staff, the `console` source shows the page URL and the user; ask them for the exact steps.

What this does not give you: request-level latency percentiles and per-request logs. Those stay in the platform's log stream (structured JSON from pino, redacted); the correlation id is the join key.

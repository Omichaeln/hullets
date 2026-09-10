# Queue backlog and dead letters

Alerts: `inbound.backlog` (oldest waiting event > 5 min), `inbound.dead_letter`, `jobs.dead_letter`.

1. Ops → Health: is the worker running (embedded or external)? If not, start it; backlog drains automatically.
2. Ops → Queues & dead letters: read the error on each dead event/job. Typical causes: extractor outage (see `media-and-extraction.md`), storage unavailable, a bug in a message (fix, deploy, then replay).
3. Replay an event (`Replay`) or retry a job (`Retry`): both reset attempts and are audited. Replaying is safe: submissions and outbox rows are idempotent per provider message and key.
4. Never delete queue rows. If the same event keeps dying after a fix, open an incident with the event id and correlation id from the audit log.

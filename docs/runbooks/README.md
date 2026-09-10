# Runbooks

| Runbook | When |
|---|---|
| [deploy.md](deploy.md) | first deployment, upgrades, rollback |
| [queue-replay.md](queue-replay.md) | inbound backlog, dead-lettered events or jobs |
| [provider-outage.md](provider-outage.md) | WhatsApp send failures, unknown outcomes, template gate |
| [media-and-extraction.md](media-and-extraction.md) | extractor outage, delayed submissions, media storage problems |
| [review-operations.md](review-operations.md) | review backlog, SLA breaches, disputes, reprocessing |
| [crm-reconciliation.md](crm-reconciliation.md) | CRM failures, unknown outcomes, version conflicts |
| [draw-day.md](draw-day.md) | running, approving, publishing, voiding a draw |
| [backup-restore.md](backup-restore.md) | backups, rehearsal, restore for real |
| [key-rotation.md](key-rotation.md) | rotating DATA_KEY, AUDIT_SIGNING_KEY, provider tokens |
| [incident.md](incident.md) | pausing intake/outbound/draws, communications, evidence |

Alerts raised by the platform name the runbook that applies (Ops → Alerts).

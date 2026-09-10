# WhatsApp send failures

Alerts: `outbound.failure` (permanent or unknown outcome), `outbound.failures` (summary).

- **retryable_failure**: the outbox backs off automatically (5 s → 5 min); nothing to do unless the count keeps growing; check Meta status and the access token expiry.
- **permanent_failure**: the provider refused (invalid recipient, opted out, template rejected). Fix the cause (e.g. approve the template, correct the number under Participants → Change phone) and `Retry` from Ops → Outbound.
- **unknown_outcome**: the request may have been delivered. Do not retry blindly: check the delivery callbacks (status column updates to delivered/read when Meta reports), the conversation transcript under Support, or ask the participant. Retry only once you know it was not delivered.
- **TEMPLATE_REQUIRED**: winner contact outside the 24-hour window needs `content.winnerTemplateName` set to an approved template in the active campaign version; then retry.
- **RECIPIENT_NOT_ALLOWED**: non-production environment with an allowlist; expected.
- **OUTBOUND_PAUSED**: the campaign control is on; release it under Campaigns → Overview & controls.

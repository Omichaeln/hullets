# Roles and permissions

Roles are assigned per staff user; a user may hold several. Separation of duties: the draw officer and the draw approver must be different people (enforced at approval), the technical administrator (`platform_admin`) holds no campaign, review, draw or winner rights, and voiding an approved draw needs a second, different approver.

| Permission | campaign_manager | reviewer | support | draw_officer | draw_approver | fulfilment | auditor | platform_admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| campaign.read | ● | ● | ● | ● | ● | ● | ● | ● |
| campaign.write / activate / masterdata.write | ● | | | | | | | |
| participant.read | ● | ● | ● | | | ● | ● | |
| participant.correct | | | ● | | | | | |
| participant.identity.reveal | | | | | | ● | ● | |
| participant.privacy (withdraw, anonymise, phone) | | | ● | | | | | ● |
| submission.read | ● | ● | ● | ● | | | ● | |
| submission.media (receipt images) | | ● | | | | | ● | |
| submission.review | | ● | | | | | | |
| submission.reprocess | | ● | | | | | | ● |
| entry.read | ● | ● | ● | ● | ● | ● | ● | |
| entry.disqualify | ● | ● | | | | | | |
| draw.read | ● | | | ● | ● | ● | ● | |
| draw.execute (freeze, execute, void) | | | | ● | | | | |
| draw.approve (approve, reject) | | | | | ● | | | |
| draw.bundle | | | | | ● | | ● | |
| winner.read | ● | | ● | | ● | ● | ● | |
| winner.manage (notify, transitions, publish draw) | | | | | | ● | | |
| winner.publish | ● | | | | | ● | | |
| support.read | ● | | ● | | | | | |
| support.handoff (claim, release, send, resend result) | | | ● | | | | | |
| ops.read | ● | | ● | | | | ● | ● |
| ops.retry (replay, retry, reconcile) | | | ● | | | | | ● |
| ops.alerts.ack | ● | | ● | | | | | ● |
| settings.write | | | | | | | | ● |
| audit.read (list, verify, checkpoint) | | | | | | | ● | ● |
| report.read | ● | ● | ● | ● | ● | ● | ● | |
| report.export | | | | | | | ● | |
| staff.manage | | | | | | | | ● |
| simulator.use (non-production) | ● | ● | ● | | | | | ● |
| evidence.record | ● | | | | | | | ● |

Source of truth: `packages/core/src/auth/policy.ts` (the console reads the same table for navigation; the server enforces it on every call). The matrix is also visible under Access → Permission matrix.

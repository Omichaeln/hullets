# Production activation checklist

The server enforces this list (`validateActivation`) when a campaign is set to `active` in a production database; the console shows it under Campaigns → Activation check and Readiness.

- [ ] Environment is `production`; simulator transport and extractor refused; secrets set (`DATA_KEY`, `AUDIT_SIGNING_KEY`, `META_*`, extractor key if used).
- [ ] Every client decision D-01…D-22 approved or marked not required, with evidence (Campaigns → Client decisions).
- [ ] No sample markers in the campaign configuration, outlets, products, staff or content ("TEST ONLY", `example.test`, fictional retailer names).
- [ ] Outlet master imported and reviewed; collection points confirmed.
- [ ] Active campaign version reviewed: rules (D-05…D-10), content (terms/privacy versions and URL, prizes text, messages), prize plan (D-16/D-17), periods (D-02/D-03).
- [ ] Winner message template approved by Meta and named in `content.winnerTemplateName`.
- [ ] Receipt benchmark on real receipts accepted (`evidence.receipt_benchmark_accepted`).
- [ ] Restore rehearsal recorded (`evidence.restore_rehearsal`); load benchmark recorded.
- [ ] Client UAT signed off (`evidence.client_uat_signoff`).
- [ ] Staff accounts created for real people with MFA; separation of duties respected (officer ≠ approver); no shared accounts.
- [ ] Monitoring: alerts routed (Ops → Alerts is the source; forward via the deployment's log pipeline), smoke check scheduled.
- [ ] Backups configured and verified.

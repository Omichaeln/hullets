# Go-live plan

1. **T-14 days**: credentials in place (Meta test number, extractor key, CRM sandbox if selected); `npm run smoke` against staging; phone-track UAT (docs/testing/client-uat.md) on staging with allowlisted test numbers; real-receipt benchmark accepted.
2. **T-7 days**: production environment deployed with the checklist green except the campaign activation; outlet master final; staff trained on the runbooks; draw-day roles named.
3. **T-1 day**: restore rehearsal on production backups; sample data must not exist in the production database (`reset:sample` is only for local/test; production is created clean).
4. **T-0**: campaign manager activates the campaign (validator must pass); Meta webhook switched to production; first real participant message observed end to end; smoke recorded.
5. **Weekly**: draw-day runbook; readiness and alerts reviewed; exports for the client.
6. **Close**: campaign `closed` (winners browsing stays), then `archived`; retention per D-22.

Dependencies outside this repository: Meta business verification and template approval lead times, the client's legal terms and privacy notice, prize logistics at collection points, CRM vendor selection.

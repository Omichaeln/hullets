# Draw day

Roles: draw officer (freeze, execute), draw approver (approve/reject), fulfilment (publish, contact), auditor (bundle, chain).

1. Officer: Draws → select the period → read the barrier. Clear blockers (review queue for the period, prize plan, candidate count) or record an override reason for unresolved submissions.
2. Officer: Freeze. Note the snapshot hash and seed commitment in the draw record (they are audited). Execute. The result appears with winners, alternates and the output hash. Executing again is harmless (same result).
3. Approver (a different person): open the draw, check the integrity panel, Approve with a note. Reject voids the draw so a new one can be frozen.
4. Fulfilment: Publish & create winner records; open each winner and Send winner message; follow the claim lifecycle (verified with evidence → accepted with a collection outlet → collected with a slip reference). Replace a non-responding winner; the first unused alternate is promoted.
5. Auditor: Download the audit bundle and keep it with the campaign records; `npm run verify:draw -- <bundle.json>` recomputes it independently. Verify the audit chain.
6. Publication of names is a separate step per winner (masked first name and initial); withdraw publication if a claim fails.
7. If the result must be voided after approval: Void & re-run with a second approver; the evidence of the voided draw is kept and linked.

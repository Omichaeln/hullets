# Client UAT script

Two tracks: **console track** (runs today on the sample data, automated by `npm run test:e2e` and repeatable by hand) and **phone track** (needs the Cloud API test number; steps are identical, the participant uses a real phone instead of the simulator).

Sign-in: use the staff accounts issued by the administrator (temporary password → forced change → optional MFA). Each persona below maps to a role.

| # | Persona | Steps | Expected | Evidence |
|---|---|---|---|---|
| U1 | Participant (simulator or phone) | Say "hi"; reply 1; give first name, surname, identity number (fictional in test), town; confirm; accept terms | Menu, guided registration with validation, terms version shown, "registered" confirmation | screenshot `uat-1-registration` |
| U2 | Participant | Reply 2; choose retailer → branch (try search "westgate" and Back); send `uat-fresh-1-A` | Outlet confirmed; acknowledgement with reference within seconds; "ONE entry has been added" | `uat-2-receipt-qualified` |
| U3 | Participant | Send the same photo again; send `uat-ambiguous-C`; reply 7 | "already been used" without naming anyone; "quick check" message; status counts correct | transcript |
| U4 | Reviewer | Submissions → queue → open the ambiguous-date item → take → correct the date → Qualify | Entry awarded by the reviewer; participant receives the after-review message; audit shows the correction and decision | `uat-4-review-decided` |
| U5 | Campaign manager | Campaigns → sample → Versions → New draft → change `allowMixedPacks` → Save → Activate; Outlets → CSV dry run with `outlets-import-invalid.csv` | New version active with a new hash; invalid CSV reported line by line without changes | screenshots |
| U6 | Draw officer | Draws → period W-1 → barrier → Freeze → Execute | Snapshot hash, seed commitment, then result with 5 winners + alternates; the officer cannot approve | `uat-5-draw-*` |
| U7 | Draw approver | Open the draw → Approve (note) | Approved; integrity "recomputed and matches" | `uat-6-draw-approved` |
| U8 | Fulfilment | Publish & create winner records → open a winner → Send winner message → Verified (evidence) → Accepted (collection outlet) → Collected (slip) → Publish | Claim reference shown once; collection instructions queued; public listing shows masked name only | `uat-7-*` |
| U9 | Auditor | Audit → Verify chain → Sign checkpoint; draw → Download audit bundle → `npm run verify:draw -- <file>` | Chain intact; bundle verifies outside the application | `uat-8-audit-verified` |
| U10 | Support | Participant says "support"; Support → claim → send a reply → release | Automation paused during the hand-off; message delivered (simulator) | transcript |
| U11 | Platform admin | Access → add a staff member → hand over the temporary password; disable a user | New user forced to change password; disabled user's session ends immediately | screenshots |
| U12 | Anyone | Readiness | Level, provider modes and open decisions stated honestly | screenshot |

Sign-off is recorded with Ops → Settings & evidence → `client_uat_signoff` (reference to the signed script).

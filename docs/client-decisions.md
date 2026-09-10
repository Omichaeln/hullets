# Client decisions (D-01 … D-22)

Every decision below is stored per campaign (`campaign_decisions`) with the **test value in use**, an approved value, a status and evidence. Open decisions that block activation are listed in the readiness report and by the production activation validator. Test values are placeholders chosen so the system can be exercised end to end; none of them are a recommendation.

| ID | Question | Test value in use (sample campaign) | Blocks activation |
|---|---|---|---|
| D-01 | Final campaign name and sponsoring brand | TEST ONLY — Sweetvale Brown Sugar Promotion (fictional brand) | yes |
| D-02 | Exact start/end, entry cutoff, draw and publication dates and timezone | seed-clock relative weeks; Monday 00:00 Africa/Harare cutoffs | yes |
| D-03 | Eight-week duration, calendar year and November end | 4 sample weeks relative to the seed clock; no live dates inferred | yes |
| D-04 | Eligible country, regions, towns and outlet scope | default country code 263; 10 fictional towns | yes |
| D-05 | Qualifying brands, SKUs, receipt aliases and pack sizes | SV-BS-2KG Sweetvale Brown Sugar 2 kg + aliases (fictional) | yes |
| D-06 | Two 2 kg packs specifically vs other combinations totalling 4 kg | strict 2 × 2000 g; `allowMixedPacks=false` (selectable per version) | yes |
| D-07 | One entry per receipt vs quantity-based multiples | `unitsPerReceipt=1` | yes |
| D-08 | Participant, household, daily, weekly or campaign caps | unlimited additional unique receipts (caps `null`) | yes |
| D-09 | Receipt dates, refunds, duplicate definition, photocopies, e-receipts | purchase window Sep–Dec 2026 (fixture dates); DMY; voided lines excluded; identity = outlet, date, number; total checked for conflicts | yes |
| D-10 | Age, staff/supplier, household and prior-winner restrictions | 18+ declaration only; `priorWinnerExclusion=none` | yes |
| D-11 | Identity number at registration or only from winners | `identityStage=registration` (encrypted, masked, audited reveal) | yes |
| D-12 | Meaning of the location field | town/city free text | yes |
| D-13 | Approved outlet master and prize collection locations | 80 fictional branches; collection points on roughly a third | yes |
| D-14 | Uncertain receipt handling, review target and pending-at-cutoff policy | 24 h review target; freeze blocked until on-time submissions are resolved (override needs a reason) | yes |
| D-15 | Participant count only or full submission status/history | `participantStatus=true` (counts + last three references) | yes |
| D-16 | Winners and alternates per period, prizes, repeat-winner restrictions | 2 × P1 + 3 × P2 per week, 1 alternate per winner, one prize per participant per draw | yes |
| D-17 | Winner verification, deadlines, collection proof and replacement rules | 7-day claim window; verified → accepted → collected at a collection point; alternates promoted on replacement | yes |
| D-18 | Permitted published winner fields and timing | first name + initial, town, prize, week; after verification and explicit publication | yes |
| D-19 | CRM product, fields, access, sandbox and launch priority | generic HTTP contract + local receiver; vendor not selected | yes |
| D-20 | Languages, support hours, escalation contacts, accessibility | English only; SUPPORT keyword hand-off; test owner ops@example.test | yes |
| D-21 | Registrations, entry volume, peaks and service targets | engineering benchmark only: 5,000 registrations, 20,000 receipts, 200/h peak | yes |
| D-22 | Data retention, deletion, hosting and processor constraints | media 90 days (config); PostgreSQL + filesystem media; processors: WhatsApp, hosting | yes |

How a decision becomes final: the campaign manager records the approved value, owner and evidence under Campaigns → Client decisions; status `approved` or `not_required` clears the block. Where the decision changes behaviour (D-05…D-10, D-15…D-18) the matching configuration is edited in a new campaign version and activated; the version hash appears on every decision made under it.

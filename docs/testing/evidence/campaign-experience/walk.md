# Campaign experience: browser walk

Playwright (Chromium) against the seeded sample database on a rebuilt console, then against an EMPTY database. Every platform role signs in with a known test password, lands on `/`, opens the campaign pages, and the campaign manager works the set-up flow. Not a substitute for `npm run test:e2e`, which runs the client UAT journey; this walk covers the account control, the dashboard landing, campaign navigation per role, the set-up sections, the read-only view with its reasons, and the empty state with creation through the UI.

Result: **130/130 checks passed, 0 browser console errors** (seeded database). The empty-database walk passed 12/12: the administrator sees the empty state with the reason they cannot create; the manager creates a campaign through the form, adds a product, a prize tier, a period and the terms, reads the readiness list, activates v1, and the dashboard shows the draft campaign with its readiness card.

| Check | Result | Detail |
|---|---|---|
| admin: lands on the campaign dashboard | pass | TEST ONLY — Sweetvale Brown Sugar Promotion Active sample |
| admin: campaign navigation present | pass | Dashboard / Submissions & review / Entries / Participants / Support / Draws / Winners & claims / Campaigns / Outlets & products / Simulator  |
| admin: performance metrics render | pass | 8 stats |
| admin: shortcuts to campaign management | pass | 7 |
| admin: header control is initials + name, nothing else | pass | PA Platform administrator |
| admin: menu states roles once | pass | Platform administrator / admin@example.test / Platform administrator |
| admin: profile, theme and sign-out preserved | pass |  |
| admin: campaigns list readable | pass | 1 rows |
| admin: campaign set-up sections visible | pass | 11 |
| admin: draws readable | pass |  |
| admin: winners readable | pass |  |
| admin: entries readable | pass |  |
| admin: draws page explains what is restricted | pass | Freezing and executing a draw needs the Draw officer role. |
| admin: set-up is read-only with a reason | pass | Editing needs the Campaign manager role. |
| admin: create campaign explains the restriction | pass | Create campaign / Creating a campaign needs the Campaign manager role. /  Ask a platform administrator under Access if you n |
| manager: lands on the campaign dashboard | pass | TEST ONLY — Sweetvale Brown Sugar Promotion Active sample |
| manager: campaign navigation present | pass | Dashboard / Submissions & review / Entries / Participants / Support / Draws / Winners & claims / Campaigns / Outlets & products / Simulator  |
| manager: performance metrics render | pass | 8 stats |
| manager: shortcuts to campaign management | pass | 7 |
| manager: header control is initials + name, nothing else | pass | SC Sample Campaign Manager |
| manager: menu states roles once | pass | Sample Campaign Manager / manager@example.test / Campaign manager |
| manager: profile, theme and sign-out preserved | pass |  |
| manager: campaigns list readable | pass | 1 rows |
| manager: campaign set-up sections visible | pass | 11 |
| manager: draws readable | pass |  |
| manager: winners readable | pass |  |
| manager: entries readable | pass |  |
| reviewer: lands on the campaign dashboard | pass | TEST ONLY — Sweetvale Brown Sugar Promotion Active sample |
| reviewer: campaign navigation present | pass | Dashboard / Submissions & review / Entries / Participants / Support / Draws / Winners & claims / Campaigns / Outlets & products / Simulator  |
| reviewer: performance metrics render | pass | 8 stats |
| reviewer: shortcuts to campaign management | pass | 7 |
| reviewer: header control is initials + name, nothing else | pass | SR Sample Reviewer |
| reviewer: menu states roles once | pass | Sample Reviewer / reviewer@example.test / Reviewer |
| reviewer: profile, theme and sign-out preserved | pass |  |
| reviewer: campaigns list readable | pass | 1 rows |
| reviewer: campaign set-up sections visible | pass | 11 |
| reviewer: draws readable | pass |  |
| reviewer: winners readable | pass |  |
| reviewer: entries readable | pass |  |
| support: lands on the campaign dashboard | pass | TEST ONLY — Sweetvale Brown Sugar Promotion Active sample |
| support: campaign navigation present | pass | Dashboard / Submissions & review / Entries / Participants / Support / Draws / Winners & claims / Campaigns / Outlets & products / Simulator  |
| support: performance metrics render | pass | 8 stats |
| support: shortcuts to campaign management | pass | 7 |
| support: header control is initials + name, nothing else | pass | SS Sample Support |
| support: menu states roles once | pass | Sample Support / support@example.test / Support |
| support: profile, theme and sign-out preserved | pass |  |
| support: campaigns list readable | pass | 1 rows |
| support: campaign set-up sections visible | pass | 11 |
| support: draws readable | pass |  |
| support: winners readable | pass |  |
| support: entries readable | pass |  |
| draw: lands on the campaign dashboard | pass | TEST ONLY — Sweetvale Brown Sugar Promotion Active sample |
| draw: campaign navigation present | pass | Dashboard / Submissions & review / Entries / Participants / Support / Draws / Winners & claims / Campaigns / Outlets & products / Readiness |
| draw: performance metrics render | pass | 8 stats |
| draw: shortcuts to campaign management | pass | 7 |
| draw: header control is initials + name, nothing else | pass | SD Sample Draw Officer |
| draw: menu states roles once | pass | Sample Draw Officer / draw@example.test / Draw officer |
| draw: profile, theme and sign-out preserved | pass |  |
| draw: campaigns list readable | pass | 1 rows |
| draw: campaign set-up sections visible | pass | 11 |
| draw: draws readable | pass |  |
| draw: winners readable | pass |  |
| draw: entries readable | pass |  |
| approver: lands on the campaign dashboard | pass | TEST ONLY — Sweetvale Brown Sugar Promotion Active sample |
| approver: campaign navigation present | pass | Dashboard / Submissions & review / Entries / Participants / Support / Draws / Winners & claims / Campaigns / Outlets & products / Integratio |
| approver: performance metrics render | pass | 8 stats |
| approver: shortcuts to campaign management | pass | 7 |
| approver: header control is initials + name, nothing else | pass | SD Sample Draw Approver |
| approver: menu states roles once | pass | Sample Draw Approver / approver@example.test / Draw approver / Auditor |
| approver: profile, theme and sign-out preserved | pass |  |
| approver: campaigns list readable | pass | 1 rows |
| approver: campaign set-up sections visible | pass | 11 |
| approver: draws readable | pass |  |
| approver: winners readable | pass |  |
| approver: entries readable | pass |  |
| fulfilment: lands on the campaign dashboard | pass | TEST ONLY — Sweetvale Brown Sugar Promotion Active sample |
| fulfilment: campaign navigation present | pass | Dashboard / Submissions & review / Entries / Participants / Support / Draws / Winners & claims / Campaigns / Outlets & products / Readiness |
| fulfilment: performance metrics render | pass | 8 stats |
| fulfilment: shortcuts to campaign management | pass | 7 |
| fulfilment: header control is initials + name, nothing else | pass | SF Sample Fulfilment |
| fulfilment: menu states roles once | pass | Sample Fulfilment / fulfilment@example.test / Fulfilment |
| fulfilment: profile, theme and sign-out preserved | pass |  |
| fulfilment: campaigns list readable | pass | 1 rows |
| fulfilment: campaign set-up sections visible | pass | 11 |
| fulfilment: draws readable | pass |  |
| fulfilment: winners readable | pass |  |
| fulfilment: entries readable | pass |  |
| auditor: lands on the campaign dashboard | pass | TEST ONLY — Sweetvale Brown Sugar Promotion Active sample |
| auditor: campaign navigation present | pass | Dashboard / Submissions & review / Entries / Participants / Support / Draws / Winners & claims / Campaigns / Outlets & products / Integratio |
| auditor: performance metrics render | pass | 8 stats |
| auditor: shortcuts to campaign management | pass | 7 |
| auditor: header control is initials + name, nothing else | pass | SA Sample Auditor |
| auditor: menu states roles once | pass | Sample Auditor / auditor@example.test / Auditor |
| auditor: profile, theme and sign-out preserved | pass |  |
| auditor: campaigns list readable | pass | 1 rows |
| auditor: campaign set-up sections visible | pass | 11 |
| auditor: draws readable | pass |  |
| auditor: winners readable | pass |  |
| auditor: entries readable | pass |  |
| longname: lands on the campaign dashboard | pass | TEST ONLY — Sweetvale Brown Sugar Promotion Active sample |
| longname: campaign navigation present | pass | Dashboard / Submissions & review / Entries / Participants / Support / Draws / Winners & claims / Campaigns / Outlets & products / Simulator  |
| longname: performance metrics render | pass | 8 stats |
| longname: shortcuts to campaign management | pass | 7 |
| longname: header control is initials + name, nothing else | pass | BM Bartholomew Montgomery-Featherstonehaugh of Cholmondeley |
| longname: menu states roles once | pass | Bartholomew Montgomery-Featherstonehaugh of Cholmondeley / longname@example.test / Reviewer |
| longname: profile, theme and sign-out preserved | pass |  |
| longname: campaigns list readable | pass | 1 rows |
| longname: campaign set-up sections visible | pass | 11 |
| longname: draws readable | pass |  |
| longname: winners readable | pass |  |
| longname: entries readable | pass |  |
| manager: section basics renders | pass |  |
| manager: section products renders | pass |  |
| manager: section rules renders | pass |  |
| manager: section registration renders | pass |  |
| manager: section content renders | pass |  |
| manager: section prizes renders | pass |  |
| manager: section outlets renders | pass |  |
| manager: section team renders | pass |  |
| manager: section decisions renders | pass |  |
| manager: section readiness renders | pass |  |
| manager: saving on a live campaign goes to a draft, live version untouched | pass | editing draft v2 => editing draft v2 |
| manager: draft value persisted | pass |  |
| manager: readiness offers to activate the draft | pass |  |
| manager: description persists | pass |  |
| mobile: header control compact | pass | 59px |
| mobile: menu fits the viewport | pass | 107..374 |
| mobile: no horizontal scroll on the dashboard | pass | 390 |
| mobile: set-up page has no horizontal scroll | pass | 390 |
| mobile: long name menu fits | pass |  |

## Screenshots

- admin-dashboard-desktop.png
- admin-dashboard-menu-desktop.png
- admin-dashboard-mobile.png
- admin-draws-desktop.png
- admin-menu-mobile.png
- admin-setup-products-mobile.png
- admin-setup-products-readonly-desktop.png
- empty-admin-dashboard-desktop.png
- empty-manager-create-desktop.png
- empty-manager-dashboard-desktop.png
- empty-manager-dashboard-draft-desktop.png
- empty-manager-setup-readiness-desktop.png
- longname-menu-mobile.png
- manager-setup-products-desktop.png
- manager-setup-readiness-draft-desktop.png

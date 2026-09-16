# The technical console

How the platform team's console is organised, and why.

## Navigation

The sidebar is grouped by **the kind of work and the cadence it happens at**, not by what the code
underneath is called.

| Group | Who, when | Destinations |
|---|---|---|
| **Run** | Operators, every day | Dashboard · Submissions & review · Entries · Participants · Support |
| **Draws** | The draw officer and approver, once a period, under separation of duties | Draws · Winners & claims |
| **Set up** | The campaign manager, before launch and between waves | Campaigns · Outlets & products · Simulator |
| **Administer** | The platform administrator, occasionally | Access · Settings |
| **System** | An engineer checking the installation is healthy | Integrations & queues · Audit log · Readiness |

A group only appears if the person holds a permission for at least one item in it, so a reviewer
never sees Administer — that is the policy in `packages/core/src/auth/policy.ts` doing its job,
not a gap.

## Who sees what: read-wide, act-narrow

Every platform role — the platform administrator included — can **see** the whole promotion:
the campaigns and their configuration, participants, submissions, entries, draws, winners and the
reports. A person who cannot see the campaign cannot understand the system they are asked to run,
review, draw or administer. What each role can **do** stays narrow and is what the policy protects:

| Doing | Role |
|---|---|
| Create, configure and activate a campaign; pause switches | Campaign manager |
| Decide a receipt; see receipt images | Reviewer (images: also the auditor) |
| Freeze and execute a draw | Draw officer |
| Approve or reject a draw (never the same person who ran it) | Draw approver |
| Contact, verify and record winners; publish results | Fulfilment |
| Unmask a national identity number (audited) | Fulfilment, auditor |
| Exports; verify the audit chain | Auditor |
| Accounts, settings, integrations | Platform administrator |

Where a control is missing from a page, the page says what it would take (for example *Approving
this draw needs the Draw approver role*) rather than leaving a gap. The client's promotion desk
roles are unchanged: they see the desk and nothing of the draw machinery.

## The dashboard

`/` is the campaign dashboard for every platform user. It is about **one** campaign — the live one,
else the one being set up — and answers the first questions on signing in: which promotion, is it
live, how is it doing, where do I go to work on it. It carries shortcuts to the campaign's set-up,
submissions, entries, participants, draws, winners and support; the reconciled metrics; the review
queue and open alerts. A draft campaign gets a "before this can go live" card that counts what is
still missing. With no campaign at all the page says so and puts **Create campaign** in the middle
of the screen (with the reason it is absent for anyone who is not a campaign manager).

Direct links are honoured: a person who opens `/draws/…` and signs in lands on that draw. The one
redirect the console owns is the temporary-password gate.

## Campaigns and set-up

**Campaigns** lists every campaign; **Create campaign** (`/campaigns/new`) takes a name, a code
suggested from it, an internal description, the window and the time zone, and lands in the set-up
flow. A campaign page (`/campaigns/:id?s=…`) is one section at a time:

| Section | Edits | Where it lives |
|---|---|---|
| Basics | name, description, window, time zone; status via the button | `campaigns` row |
| Products & qualification | products, aliases, pack sizes, threshold, entries per receipt | version `rules` |
| Entry rules | caps, eligibility, purchase window, outlet match, reader thresholds | version `rules` |
| Registration & receipts | identity stage, location mode, "my entries", date order | version `flags`, `rules.dateOrder` |
| Terms & messages | terms/privacy versions and link, prizes copy, artwork, winner template, message overrides | version `content` |
| Prizes & draws | prize tiers, stand-bys, claim days; draw periods | version `prizePlan`; `campaign_periods` |
| Participating outlets | membership, collection points, CSV import | `campaign_outlets` |
| Team & controls | who holds which role (platform-wide); pause switches | accounts; `campaign_controls` |
| Client decisions | the decision register | `campaign_decisions` |
| Readiness & activation | the validator, in words, with a Fix link per item; activate the draft; go live | — |

The protections are the server's and hold throughout: an **active** version is immutable, so a
save on a live campaign opens a **draft** version and says so (participants keep the live one until
the draft is activated under Readiness); a drawn period cannot change; a closed campaign cannot
change; going live is `campaign.activate` and in production runs the validator first. Everyone
else sees the same sections read-only, with the role that could edit them named at the foot.

Readiness judges the configuration that *would* be live — the active version, or the latest draft
while nothing is active — so a campaign being set up sees its own gaps rather than the gaps of a
version that does not exist.

What does not exist, stated so nobody looks for it: **per-campaign team membership** (roles are
held on the account and apply to every campaign) and **per-campaign branding** beyond the
participant-facing name, prize artwork and message wording.

**The person's own things are not navigation.** Account, password, two-step verification, theme and
sign-out are about the person, not the product, so they live on the person: the compact control in
the top-right — initials, the name (clipped, never wrapped; hidden on a phone), a chevron — opens
a menu that states the person's name, e-mail and roles **once**, then My account, the theme and
Sign out. "My account" used to sit in the sidebar between the audit log and the readiness report,
and the roles used to be printed in the header as well as the menu.

## The sidebar

On a desktop the sidebar collapses to a 64px rail — icons with the label as a tooltip, the roundel
in place of the lock-up — using the fold control in the sidebar's own header. The choice is
remembered per browser. On a phone the sidebar is a drawer opened from the hamburger in the top bar,
which is the only place it can live when the sidebar is off-canvas.

One attribute on the shell, `data-collapsed`, drives both modes so they cannot drift apart. Worth
knowing before someone "tidies" the CSS: the previous mobile-only hamburger was visible on every
desktop because `.tt-menu-btn { display: none }` and `.btn { display: inline-flex }` had equal
specificity and `.btn` was declared later; and the scrim had no desktop rule at all, so on a wide
screen it rendered as an ordinary block, took the sidebar's grid column, and shoved the sidebar and
the content out of place the moment the menu opened. Both controls are now scoped to `.tt-shell`
and `tests/unit/console-routing.test.ts` pins it.

## Where settings live

Almost everything someone might call a setting lives somewhere more specific, and **Settings** says
so rather than pretending otherwise:

- The promotion's rules, prizes, periods and messages are a **versioned campaign**, under Set up →
  Campaigns, activated under dual control.
- Shops and products are **master data** under Set up → Outlets & products.
- People are **accounts** under Administer → Access.
- Providers — WhatsApp, the receipt extractor, the CRM, storage — are **environment variables** on
  the deployment. The console reads their state under System → Integrations & queues → Health and
  never writes it.

What remains is a small JSON key/value store. Exactly one key is consumed by the running system
(`sample_data`, a stamp written by the sample seed) and a family of `evidence.*` stamps is written
from the Readiness page. Settings lists every stored row with what it is and who wrote it, and keeps
the raw editor as an explicitly labelled advanced tool. It used to be a tab called "Settings &
evidence" on the Integrations & queues page, with a default key that nothing reads.

Readiness evidence is recorded **on the Readiness page**, next to the row that says it is missing,
rather than on a settings tab two pages away.

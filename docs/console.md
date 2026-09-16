# The technical console

How the platform team's console is organised, and why.

## Navigation

The sidebar is grouped by **the kind of work and the cadence it happens at**, not by what the code
underneath is called.

| Group | Who, when | Destinations |
|---|---|---|
| **Run** | Operators, every day | Overview · Submissions & review · Entries · Participants · Support |
| **Draws** | The draw officer and approver, once a period, under separation of duties | Draws · Winners & claims |
| **Set up** | The campaign manager, before launch and between waves | Campaigns · Outlets & products · Simulator |
| **Administer** | The platform administrator, occasionally | Access · Settings |
| **System** | An engineer checking the installation is healthy | Integrations & queues · Audit log · Readiness |

A group only appears if the person holds a permission for at least one item in it, so a reviewer
never sees Administer and a platform administrator never sees Run — that is the policy in
`packages/core/src/auth/policy.ts` doing its job, not a gap.

**The person's own things are not navigation.** Account, password, two-step verification, theme and
sign-out are about the person, not the product, so they live on the person: the name and role in the
top-right open a menu. "My account" used to sit in the sidebar between the audit log and the
readiness report.

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

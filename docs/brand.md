# Huletts branding in this console

Applied from *Huletts Brand Guidelines 2020* (Brand Kit, pages 4–10). This page records what was
taken from that document, what was decided where the document does not reach, and where each thing
lives, so a future change does not have to re-derive any of it.

## The mark

Extracted as vector directly from the guidelines PDF, not redrawn. Both approved colourways ship:

| File | Use |
|---|---|
| `huletts-vertical.svg` | The **primary** lock-up. Use wherever space allows |
| `huletts-horizontal.svg` | Where space is limited |
| `huletts-icon.svg` | The H roundel alone, for favicons and avatars |
| `*-reverse.svg` | The all-white reverse, for red, blue, black or dark-theme grounds |
| `huletts-wave.svg` | The wave device, at its own 13° |
| `favicon.svg` | The roundel, brand red on a light tab, white on a dark one |

They live in `apps/console/public/brand/` and are served at `/brand/*` — by Vite in development
and by the API's `express.static` over `apps/console/dist` in production.

Four rules from the guidelines are enforced in code rather than left to whoever writes the next
screen. All four live in the `Brand` component in `apps/console/src/ui/kit.tsx`:

- **All three elements travel together.** The H icon, *Est. 1892* and the wordmark are one lock-up.
  `Brand` only ever renders a complete one; there is no way to ask it for a wordmark on its own,
  and no wordmark-only asset exists to make it possible.
- **Clear space is the height of the H icon.** That ratio is not the same for the two lock-ups, so
  it is measured from the artwork — the icon is 78% of the horizontal lock-up's height and 42% of
  the vertical one's — and applied as padding, which holds at any size.
- **The mark is never restyled.** It ships as artwork, so there is nothing for CSS to stretch,
  recolour or add a shadow to. The reverse is a separate file chosen by a CSS rule, not a filter
  applied to the colour one.
- **`box-sizing: content-box` on `.brand-mark img`.** The global `border-box` rule makes padding
  eat the element's height, which renders a 28px mark with its clear space as a 6px smudge. Worth
  knowing before someone "tidies" it.

The H in the roundel is a genuine knockout, not a white fill, so the mark sits correctly on any
ground without a second file.

## Colour

The brand's primary palette is exactly two values. Do not alter them.

| Token | Value | Source |
|---|---|---|
| `--huletts-blue` | `#002F87` | Pantone 287 C · C100 M86 Y19 K10 · R0 G47 B135 |
| `--huletts-red` | `#D7282F` | Pantone 1795 C · C10 M97 Y92 K1 · R215 G40 B47 |

**Interaction is blue; red is identity and stop.** This is a decision, not something the guidelines
say. Red is the brand's hero colour, but this is a tool whose job includes disqualifying a shopper's
entry and reporting failed deliveries, and a red button reads as "stop" to every operator regardless
of what a brand book says. So blue carries every interactive state — navigation, primary buttons,
links, focus — and the single red carries the logo, the wave, and destructive actions and errors.
One red, two honest meanings, rather than two reds a tired operator has to tell apart at 5pm.

`--tt-info` is the brand blue rather than TapTap's original `#1d4ed8`: a second, unrelated blue
sitting beside the primary reads as a mistake rather than a distinction.

### Two derivations the brand book does not reach

Both are forced by contrast, not taste. Both were measured rather than judged by eye, and
`tests/unit/brand.test.ts` recomputes every ratio so a later token edit cannot quietly break one.

**Dark mode.** TapTap ships a full dark theme. Huletts blue on its `#111a2b` surface is **1.46:1** —
invisible. The dark theme therefore raises the *lightness* of each brand hue while holding hue and
saturation exactly, so it stays recognisably the same colour instead of drifting toward a different
blue. (Mixing toward white, the obvious alternative, desaturates and greys it.) The logo needs no
such treatment: it follows the brand's own reverse rule and goes white.

| | Light | Dark | Ratio in its theme |
|---|---|---|---|
| `--tt-primary` | `#002F87` | `#5C95FF` | 11.96 on white · 5.97 on `#111a2b` |
| `--tt-danger` | `#D7282F` | `#E15C61` | 4.96 white-on-red · 4.89 on `#111a2b` |

**Red text.** Brand red as small text on a visible pink tint is **4.11:1**, under AA. Brand red is
kept for everything red is *seen as* — fills, dots, solid buttons, the mark — and `--tt-danger-text`
(`#A31E24`, the same hue darkened to L38) carries red *text* where AA demands it, at 6.29:1. It is a
derivative of the brand red, not a second brand colour.

One further structural change: `--tt-on-primary` was doing two jobs that teal could serve with one
value and navy cannot — text *on* solid primary must be white, text on the pale primary *tint* must
be the navy. Splitting it into `--tt-on-primary` and `--tt-on-primary-soft` also let two dark-mode
override rules be deleted rather than added to.

The secondary palette (speciality sugars and Equisweet) is not used: it is a product-range system,
and nothing in this console is a product. Note also that the guidelines' secondary table has errors
— Treacle and Equisweet Erythritol both carry the primary blue's RGB values, and "Pantone 27571 C"
is not a real Pantone reference. Worth resolving with the brand owner before anyone uses that
palette for anything.

The artwork in the PDF renders *Est. 1892* at `#1F3D7B`, which is not Pantone 287 C. The extraction
normalises it to the specified `#002F87`.

## Type

| Role | Brand font | What ships |
|---|---|---|
| Headlines | Gotham Black | Montserrat 700 (`--tt-font-display`) |
| Body | Gotham Book | Montserrat 400/600 (`--tt-font`) |
| Emphasis | Nexa Rust Script | not used |

**Gotham is licensed from Hoefler&Co and cannot be redistributed**, so the console cannot ship in
the brand typeface. Montserrat is the closest freely licensable geometric sans, self-hosted as one
37 kB variable font so there is no runtime dependency on a font CDN. Both stacks name Gotham
*first*: drop a licensed web kit into `public/brand/fonts/`, add two `@font-face` rules, and the
console picks it up with no other change.

One cost of the substitution, worth knowing before someone reports it as a bug: Montserrat's zero
has a very tight counter at 600 and above, so at headline sizes a `0` can read as an `8` at a
glance. That is the typeface's own design, not a misuse of it. It is deliberately not patched with
a weight override tuned to Montserrat, because that override would be wrong the day a Gotham web
kit is dropped in — Gotham's zero is open.

Nexa Rust Script is a display face for packaging and posters. It has no place in a data table and
is not loaded.

## The 13° slant

The wave and every headline treatment sit at 13°. In this console that angle appears only on the
wave device on the sign-in screen. Slanted text in a console full of tables and numbers costs
legibility for nothing, so headings are set upright.

## Spelling: Huletts, not Hullets

The repository, its package name and several wire identifiers spell the brand **Hullets**. The brand
is **Huletts**. Every *user-visible* occurrence is now corrected — the console title, the sidebar,
the sign-in screen, the product name the API reports, and the prose in `README.md`, `Dockerfile` and
`.env.example`.

The following deliberately keep the original spelling, because they are interfaces rather than
presentation and renaming them is a breaking change, not branding:

| Identifier | Where | Why it stays |
|---|---|---|
| `hullets-api/1` | `apps/api/src/contract.ts`, `docs/api/contract.json` | The published contract version; `tools/smoke.ts` asserts it |
| `hullets-promo` | `packages/core/src/crm/index.ts` | The CRM `source` field a counterparty keys on |
| `hullets.token` | `apps/console/src/lib/trpc.ts` | Renaming the storage key signs every current user out |
| `hullets` | `package.json`, Docker tag, temp-dir prefixes | Build and workspace identity, never shown to anyone |

Changing any of those is a decision for whoever owns the counterparty integrations, not a branding
task.

## What is deliberately *not* branded

The **participant's WhatsApp messages**. That copy is campaign content, versioned and edited by the
client, not system chrome. Baking "Huletts" into the conversation engine's defaults would put one
client's brand into the fallback every campaign inherits. The campaign name already carries the
brand, and the tagline — *A little Huletts sweetness goes a long way* — is available to use in that
content wherever the client wants it. `tests/unit/brand.test.ts` asserts the engine stays clean.

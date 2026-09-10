# TapTap design system in the console

The console implements the TapTap tokens as CSS custom properties in `apps/console/src/styles/taptap.css` and a small component kit in `apps/console/src/ui/kit.tsx`. The Figma source was not reachable from the build environment, so the token values are the ones supplied for this project; adjust the variables in one place if the source differs.

## Tokens

| Group | Values |
|---|---|
| Brand | primary `#00D9C5`, hover `#00c4b2`, active `#00ad9d`, text on primary `#062a27`, soft `#d9faf6` / `#b3f4ec`, link `#0b8f84` |
| Neutrals (light) | background `#f6f8fa`, surface `#ffffff`, surface-2 `#f1f4f7`, border `#dfe4ea` / `#c6ced8`, text `#0f172a` / `#475569` / `#64748b`, muted `#94a3b8` |
| Neutrals (dark) | background `#0b1220`, surface `#111a2b`, surface-2 `#172236`, border `#223047` / `#2f4060`, text `#e6edf6` / `#b6c2d3` / `#8fa0b8` |
| Semantic | success, warning, danger, info each with a soft background |
| Type | Inter with the system stack; 14 px base, 22/17/15/13 headings, mono for identifiers |
| Spacing | 4 px scale (4, 8, 12, 16, 20, 24, 32, 40) |
| Radii | 6 (controls), 8 (buttons, inputs), 12 (cards, modals) |
| Elevation | three shadows (`--tt-sh-1..3`) |
| Focus | 3 px primary ring |

Dark mode follows the system preference and can be forced with `data-theme="dark|light"` on the root element; every colour is defined on `:root` first.

## Components

`PageHead`, `Card`, `Stat`, `Button` (primary/danger/ghost, sm/lg, loading), `Badge` (status-aware tones), `Field`/`Input`/`Select`/`Textarea`/`Checkbox` (labels associated by id), `Tabs`, `Table` (clickable rows, numeric columns, empty state), `KV`, `Modal`, `ActionDialog` (confirm-with-reason used for every consequential action), `ToastProvider`, `AuthImage` (bearer-authenticated image), `Callout`, `Json`, `Loading`, `Empty`.

## Layout

Sidebar navigation grouped by Operate / Draws & prizes / Configure / Platform, filtered by the user's permissions (the server enforces them regardless); topbar with environment badge and provider warnings; content max width 1440 px; responsive below 900 px with an off-canvas menu. Screenshots for desktop and mobile are produced by `npm run test:e2e` under `docs/testing/evidence/screenshots`.

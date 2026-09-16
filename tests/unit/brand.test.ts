// Huletts branding: the invariants that survive a redesign.
//
// A brand breaks in software by drift, not by a single wrong commit — a hex value typed by hand, a
// lock-up cropped to "just the wordmark", a reverse logo faked with a CSS filter, a token nudged
// until small red text stops being legible. These tests pin what the guidelines actually require
// and what the contrast maths actually permits, so the next person to touch the stylesheet finds
// out here rather than in a screenshot review.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const CSS = "apps/console/src/styles/taptap.css";
const BRAND = "apps/console/public/brand";

const BLUE = "#002F87";                          // Pantone 287 C
const RED = "#D7282F";                           // Pantone 1795 C

/** WCAG 2.1 relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Read a custom property out of a given block of the stylesheet. */
function token(block: string, name: string): string {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --${name} not found`);
  return m[1].trim();
}
function blocks() {
  const css = read(CSS);
  const light = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
  const dark = css.slice(css.indexOf(':root[data-theme="dark"] {'));
  return { css, light, dark: dark.slice(0, dark.indexOf("}") + 1) };
}

describe("Huletts branding", () => {
  it("ships both approved colourways of every lock-up as real artwork", () => {
    for (const name of ["huletts-vertical", "huletts-horizontal", "huletts-icon"]) {
      for (const variant of ["", "-reverse"]) {
        const svg = read(`${BRAND}/${name}${variant}.svg`);
        expect(svg, `${name}${variant} is vector`).toMatch(/<path/);
        expect(svg).not.toMatch(/<image/);       // not a screenshot of a logo
      }
    }
    // The reverse is a SEPARATE FILE, so nothing has to fake it with a CSS filter.
    for (const name of ["huletts-vertical", "huletts-horizontal", "huletts-icon"]) {
      const rev = read(`${BRAND}/${name}-reverse.svg`);
      const fills = [...rev.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toUpperCase());
      expect(fills.length, `${name}-reverse has fills`).toBeGreaterThan(0);
      expect(new Set(fills), `${name}-reverse is all white`).toEqual(new Set(["#FFFFFF"]));
    }
  });

  it("uses the two specified brand values and nothing that merely looks like them", () => {
    const { css, light } = blocks();
    expect(token(light, "huletts-blue").toUpperCase()).toBe(BLUE);
    expect(token(light, "huletts-red").toUpperCase()).toBe(RED);
    // The teal the console used before the brand, and hand-typed near-misses of either primary.
    for (const stray of ["#00d9c5", "#00c4b2", "#00ad9d", "#062a27", "#0b8f84", "#3fd9ca", "#b42318", "#d7292e", "#1f3d7b"]) {
      expect(css.toLowerCase(), `${stray} must not reappear`).not.toContain(stray);
    }
  });

  it("every foreground/background pair the tokens create clears WCAG AA", () => {
    const { light, dark } = blocks();
    // Light. Text on solid primary is white; text on the primary TINT is the navy — one token
    // cannot do both jobs, which is why --tt-on-primary-soft exists.
    expect(contrast("#FFFFFF", BLUE)).toBeGreaterThanOrEqual(4.5);          // .btn.primary
    expect(contrast(BLUE, token(light, "tt-primary-soft"))).toBeGreaterThanOrEqual(4.5); // active nav, .badge.primary
    expect(contrast(BLUE, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);          // links on surface
    expect(contrast("#FFFFFF", RED)).toBeGreaterThanOrEqual(4.5);           // .btn.danger
    // Brand red as SMALL TEXT on the pink tint is 4.11 — under AA. That is why red text uses a
    // darkened shade of the same hue while fills keep the brand value.
    expect(contrast(RED, token(light, "tt-danger-soft"))).toBeLessThan(4.5);
    expect(contrast(token(light, "tt-danger-text"), token(light, "tt-danger-soft"))).toBeGreaterThanOrEqual(4.5);

    // Dark. Huletts blue on this theme's surface is 1.46 — invisible; the dark theme must raise
    // lightness rather than reuse the brand value.
    const SURFACE = "#111a2b";
    expect(contrast(BLUE, SURFACE)).toBeLessThan(3);
    expect(contrast(token(dark, "tt-primary"), SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(dark, "tt-on-primary"), token(dark, "tt-primary"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(dark, "tt-primary"), token(dark, "tt-primary-soft"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(dark, "tt-danger"), SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(dark, "tt-danger-text"), token(dark, "tt-danger-soft"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the dark theme keeps the brand hue rather than drifting to another blue", () => {
    const { dark } = blocks();
    const hue = (hex: string) => {
      const h = hex.replace("#", "");
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (!d) return 0;
      const deg = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (deg * 60 + 360) % 360;
    };
    // Lightening by mixing toward white desaturates and greys the colour; raising HSL lightness
    // holds it. Within a couple of degrees of the brand hue is "the same blue".
    expect(Math.abs(hue(token(dark, "tt-primary")) - hue(BLUE))).toBeLessThan(3);
    expect(Math.abs(hue(token(dark, "tt-danger")) - hue(RED))).toBeLessThan(3);
  });

  it("the mark is never restyled, cropped or faked", () => {
    const css = read(CSS);
    const rules = css.split("}").filter((r) => r.includes(".brand-mark"));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      for (const banned of ["filter:", "transform: scale", "box-shadow", "background-image"]) {
        expect(r, `"do not add any graphic styling": found ${banned}`).not.toContain(banned);
      }
    }
    // Without content-box the global border-box rule makes clear space shrink the artwork.
    expect(css).toContain("box-sizing: content-box");
    // There is no wordmark-only asset, so no screen can render one by accident.
    expect(fs.existsSync(path.join(ROOT, BRAND, "huletts-wordmark.svg"))).toBe(false);
    // Clear space is derived from the artwork, not a magic number per call site.
    expect(read("apps/console/src/ui/kit.tsx")).toMatch(/CLEAR_SPACE\s*=\s*\{\s*horizontal:\s*0\.78,\s*vertical:\s*0\.42/);
  });

  it("names Gotham first and self-hosts its stand-in, so there is no font-CDN dependency", () => {
    const css = read(CSS);
    expect(css).toMatch(/--tt-font:\s*"Gotham Book"/);
    expect(css).toMatch(/--tt-font-display:\s*"Gotham Black"/);
    expect(css).toContain('url("/brand/fonts/montserrat-latin.woff2")');
    expect(fs.existsSync(path.join(ROOT, BRAND, "fonts/montserrat-latin.woff2"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, BRAND, "fonts/OFL.txt")), "the SIL licence ships with the font").toBe(true);
    expect(css).not.toContain("fonts.googleapis.com");
    expect(css).not.toContain("fonts.gstatic.com");
  });

  it("the console's own chrome carries the brand, correctly spelled", () => {
    const html = read("apps/console/index.html");
    expect(html).toContain("<title>Huletts Promotions Console</title>");
    expect(html).toContain('href="/brand/favicon.svg"');
    expect(html).toContain('content="#002F87"');
    expect(html).not.toContain("00D9C5");        // the old inline teal square
    expect(read("apps/api/src/routers/ops.ts")).toContain('productName: "Huletts Promotions"');
    // The wire identifiers deliberately keep the repository's original spelling: renaming a
    // contract version, a CRM source field or a storage key is a breaking change, not branding.
    expect(read("apps/api/src/contract.ts")).toContain('contract: "hullets-api/1"');
    expect(read("packages/core/src/crm/index.ts")).toContain('source: "hullets-promo"');
  });

  it("the participant's WhatsApp copy is left unbranded on purpose", () => {
    // That copy is campaign content the client versions, not system chrome. Baking one client's
    // brand into the fallback every campaign inherits would be wrong.
    const engine = read("packages/core/src/conversation/engine.ts");
    expect(engine.toLowerCase()).not.toContain("huletts");
  });
});

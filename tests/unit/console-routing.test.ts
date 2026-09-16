// Console routing guards.
//
// These are SOURCE assertions, not behavioural tests: the console is a React app
// and nothing here renders it. They exist because the bug they pin was invisible
// to every other kind of test — the API was healthy, every procedure returned
// correctly, and the page was blank. The behaviour was verified in a real
// browser; this file stops the specific anti-pattern coming back, and says
// plainly that it cannot prove the screen renders.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const app = fs.readFileSync(path.join(ROOT, "apps/console/src/app.tsx"), "utf8");
/** The body of Routes(), where the redirect lives. */
const routes = app.slice(app.indexOf("function Routes()"));

describe("console routing", () => {
  it("never redirects during render", () => {
    // navigate() dispatches `tt:navigate` synchronously, and on the first render
    // usePath's addEventListener effect has not run yet — so the event reaches no
    // listener, the URL changes, the component returns null, and nothing ever
    // re-renders. That is a permanently blank console, and it was on the path
    // every staff member takes on their first sign-in.
    //
    // Stated as the exact shape of the defect rather than "no navigate() during
    // render": a generic rule needs to know which calls sit inside a callback,
    // which a regex cannot tell reliably, and a guard with false positives is one
    // the next maintainer deletes.
    const code = routes.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    for (const line of code.split("\n")) {
      const redirectAndBail = line.includes("navigate(") && /return null/.test(line);
      expect(redirectAndBail, `apps/console/src/app.tsx redirects and bails out in one render pass, which leaves a blank page:\n${line.trim()}`).toBe(false);
    }
    // The one redirect Routes() owns belongs to an effect.
    expect(code).toMatch(/useEffect\(\(\) => \{ if \(needsPasswordChange && !onAccount\) navigate\("\/account\?mustChange=1"/);
  });

  it("the password gate is keyed on the flag, not on the current path", () => {
    // Keying it on `path !== "/account"` makes it go false the instant the
    // redirect lands, so the guard stops applying exactly when it has succeeded.
    // A promotion user then fell through to the desk and every query failed with
    // PASSWORD_CHANGE_REQUIRED.
    expect(routes).toMatch(/const needsPasswordChange = !!me\?\.mustChangePassword;/);
    expect(routes).not.toMatch(/mustChangePassword && path !== "\/account"/);
    // ...and it outranks console selection: whichever console a person belongs to,
    // a temporary password means they get their account page and nothing else.
    expect(routes.indexOf("if (needsPasswordChange)")).toBeLessThan(routes.indexOf("if (promotion && !forceFull)"));
  });

  it("which console a person sees is decided by roles, never by stored preference", () => {
    // A setting can be lost, copied between accounts, or edited in devtools. The
    // roles on the account cannot.
    expect(routes).toMatch(/me\.roles\.some\(\(r\) => PROMOTION_ROLES\.includes\(r\)\)/);
    expect(routes).toMatch(/me\.roles\.some\(\(r\) => TECHNICAL_ROLES\.includes\(r\)\)/);
    // The only escape hatch is for someone who ALSO holds a technical role.
    expect(routes).toMatch(/onSwitchToFull=\{technical \? \(\) => setForceFull\(true\) : null\}/);
    expect(app).not.toMatch(/localStorage[^\n]*console|localStorage[^\n]*desk["']?\s*\)\s*===/);
  });
});

describe("console information architecture", () => {
  const css = fs.readFileSync(path.join(ROOT, "apps/console/src/styles/taptap.css"), "utf8");
  const nav = app.slice(app.indexOf("const NAV"), app.indexOf("function Shell("));

  it("personal settings are on the person, not in the product's navigation", () => {
    // "My account" used to sit in the sidebar between the audit log and the
    // readiness report. It belongs on the user menu with the theme and sign-out.
    expect(nav).not.toContain('"/account"');
    expect(app).toMatch(/<Menu[\s\S]*to="\/account"/);
    expect(app).toMatch(/Sign out/);
  });

  it("settings are separate from the work and from the technical logs", () => {
    expect(nav).toMatch(/group: "Administer"[\s\S]*"\/settings"/);
    expect(nav).toMatch(/group: "System"[\s\S]*"\/ops"[\s\S]*"\/audit"/);
    expect(app).toContain('path === "/settings"');
    // ...and the observability page no longer hides a settings editor in a tab.
    const ops = fs.readFileSync(path.join(ROOT, "apps/console/src/pages/ops.tsx"), "utf8");
    expect(ops).not.toContain("Settings & evidence");
    expect(ops).not.toMatch(/title="Settings"/);
    expect(fs.existsSync(path.join(ROOT, "apps/console/src/pages/settings.tsx"))).toBe(true);
  });

  it("the sidebar has a real collapse and the mobile controls cannot leak onto desktop", () => {
    // One attribute drives both modes so they cannot drift apart.
    expect(css).toContain('.tt-shell[data-collapsed="true"] { grid-template-columns: 64px 1fr; }');
    expect(app).toContain("data-collapsed=");
    // The old mobile-only hamburger was visible on every desktop: `.tt-menu-btn {display:none}`
    // and `.btn {display:inline-flex}` had equal specificity and .btn was declared later.
    expect(css).toContain(".tt-shell .tt-menu-btn { display: none; }");
    expect(css).not.toMatch(/^\.tt-menu-btn \{ display: none; \}/m);
    // The scrim had no desktop rule and became the first grid child when opened.
    expect(css).toContain(".tt-scrim { display: none; }");
    expect(app).not.toContain('{open && <div className="tt-scrim"');
  });

  it("every platform user lands on the campaign dashboard, and direct links are honoured", () => {
    // "/" is the dashboard for the technical console; the promotion desk keeps its own Today.
    expect(routes).toMatch(/if \(path === "\/"\) page = <DashboardPage \/>;/);
    expect(nav).toMatch(/\{ to: "\/", label: "Dashboard", perm: "report.read" \}/);
    // The create page is matched BEFORE the :id pattern, or "new" would be read as a campaign id.
    expect(routes.indexOf('path === "/campaigns/new"')).toBeGreaterThan(-1);
    expect(routes.indexOf('path === "/campaigns/new"')).toBeLessThan(routes.indexOf('match("/campaigns/:id"'));
    // Nothing in Routes() rewrites a deep link on sign-in: the one redirect is the password gate.
    const body = routes.slice(0, routes.indexOf("function Session(")).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect((body.match(/navigate\(/g) ?? []).length).toBe(1);
  });

  it("the account control states the person's roles once, in the menu, not in the header", () => {
    const shell = app.slice(app.indexOf("function Shell("), app.indexOf("function Routes()"));
    const trigger = shell.slice(shell.indexOf("<Menu"), shell.indexOf("<div className=\"tt-menu-head\""));
    expect(trigger).not.toMatch(/roles|roleLabel|titleCase/);
    expect(trigger).toContain('className="tt-avatar"'); expect(trigger).toContain('className="tt-user-name"'); expect(trigger).toContain('className="tt-user-chevron"');
    expect(shell).toMatch(/tt-menu-roles[\s\S]*roleLabel\(r\)/);
    // The trigger has an accessible name even when the visible name is hidden on a phone.
    expect(trigger).toMatch(/ariaLabel=\{`Account menu: /);
    expect(css).toContain(".tt-user-name { display: block; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;");
    expect(css).not.toContain(".tt-user-name small");
  });

  it("the placeholder teal square is gone", () => {
    expect(css).not.toContain(".tt-brand .mark");
    expect(app).not.toContain('<span className="mark">');
  });
});

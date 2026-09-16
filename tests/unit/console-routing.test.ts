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

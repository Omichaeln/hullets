/**
 * Theme choice. The stylesheet already honours `<html data-theme="light|dark">`
 * over the OS preference; nothing set it before, so dark mode was reachable
 * only by changing the operating system. "system" removes the attribute and
 * lets `prefers-color-scheme` decide, which is the default.
 *
 * Stored per browser: a theme is a viewer's convenience, not account state.
 */
export type Theme = "system" | "light" | "dark";
export const THEMES: Array<[Theme, string]> = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
const KEY = "hullets.theme";

export function getTheme(): Theme {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}
export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === "system") delete el.dataset.theme; else el.dataset.theme = t;
  try { if (t === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* storage unavailable: lasts for the page */ }
}
/** Call once before first render so the first paint is already in the chosen theme. */
export function initTheme() { applyTheme(getTheme()); }

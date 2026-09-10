import type { OutletCandidate } from "./types.ts";
const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string) => norm(s).split(" ").filter((w) => w.length > 2);

/** Rank approved outlets against the receipt header. Retailer alone (0.4) or town alone (capped 0.3) stays below the default acceptance threshold (0.5): retailer AND branch/town must be legible, or an exact alias. */
export function matchOutlets(header: string, outlets: Array<{ id: string; retailer: string; branch: string; town: string; aliases: string[] }>): OutletCandidate[] {
  const ht = new Set(tokens(header)); if (!ht.size) return [];
  const overlap = (name: string) => { const t = tokens(name); return t.length ? t.filter((x) => ht.has(x)).length / t.length : 0; };
  const out: OutletCandidate[] = [];
  for (const o of outlets) {
    const r = overlap(o.retailer); const local = Math.max(overlap(o.branch), overlap(o.town)); const alias = o.aliases.some((a) => overlap(a) >= 0.99);
    // a town alone is not evidence of the shop: without a retailer token the score is capped below the acceptance threshold
    const score = alias ? 1 : r === 0 ? Math.min(0.3, Number((0.6 * local).toFixed(2))) : Number((0.4 * r + 0.6 * local).toFixed(2));
    if (score >= 0.4) out.push({ outletId: o.id, score, basis: alias ? "alias" : `retailer=${r.toFixed(2)} local=${local.toFixed(2)}` });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}
/** Match a line description to the versioned product catalogue by code, name or alias containment (normalised). */
export function matchProduct(description: string, products: Array<{ code: string; name: string; aliases: string[]; packGrams: number; qualifying: boolean }>) {
  const d = norm(description); if (!d) return null;
  for (const p of products) { if (!p.qualifying) continue; for (const k of [p.code, p.name, ...p.aliases].map(norm).filter(Boolean)) if (d.includes(k)) return { code: p.code, packGrams: p.packGrams, basis: k }; }
  return null;
}

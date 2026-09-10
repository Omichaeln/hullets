import { sha256 } from "./crypto.ts";
/** Canonical JSON: sorted keys, no whitespace, undefined -> null. Used for every hash the platform commits to. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export const hashOf = (v: unknown) => sha256(canonicalJson(v));

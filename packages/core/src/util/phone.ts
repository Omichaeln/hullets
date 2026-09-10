/**
 * Channel identity normalisation: international digits without "+". A local number
 * with a leading 0 receives the configured default country code; existing country
 * codes are never stripped, so numbers from two countries can never merge.
 */
export function normalisePhone(raw: string | null | undefined, defaultCountryCode: string): string | null {
  let s = String(raw ?? "").replace(/\D/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = s.slice(2);
  else if (s.startsWith("0")) s = defaultCountryCode + s.slice(1);
  if (s.length < 8 || s.length > 15) return null;
  return s;
}
export const maskPhone = (p: string | null | undefined) => (p ? `***${String(p).slice(-4)}` : null);

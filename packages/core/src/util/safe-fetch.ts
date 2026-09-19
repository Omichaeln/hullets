import dns from "node:dns/promises";
import net from "node:net";
import { request } from "node:https";
import { URL } from "node:url";

/**
 * Outbound HTTPS to an address derived from untrusted input.
 *
 * Everything here exists because the destination comes off a receipt somebody
 * photographed. The defences, in order:
 *
 * - HTTPS only, port 443 only, no embedded credentials.
 * - A host allowlist. `requireAllowlist` makes an empty list mean "refuse",
 *   never "permit the whole public internet"; only a caller that genuinely has
 *   no allowlist to apply may opt out.
 * - Every hostname is resolved and every returned address checked against
 *   private, loopback, link-local and reserved ranges, including IPv4-mapped
 *   IPv6.
 * - The socket connects to the resolved ADDRESS while keeping the original SNI
 *   and Host header, so the name cannot resolve to something else between the
 *   check and the connection. That is what closes DNS rebinding.
 * - Timeout, byte cap and redirect cap, with every hop revalidated.
 */
export type SafeFetchConfig = { timeoutMs: number; maxBytes: number; maxRedirects: number; allowedHosts: string[]; requireAllowlist?: boolean };
export type SafeFetchResult = { url: URL; status: number; contentType: string; body: Buffer };

export class SafeFetchRefused extends Error {
  constructor(public code: "invalid_url" | "blocked_url" | "fetch_failed" | "unsupported_content", message: string) { super(message); }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function hostAllowed(host: string, allowed: string[], requireAllowlist: boolean) {
  if (!allowed.length) return !requireAllowlist;
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function isPrivateAddress(address: string) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || a === 240 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && b >= 18 && b <= 19);
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff") || normalized.startsWith("2001:db8:");
}

export async function safeAddresses(hostname: string) {
  if (net.isIP(hostname)) { if (isPrivateAddress(hostname)) throw new SafeFetchRefused("blocked_url", "host resolves to a private or reserved address"); return [hostname]; }
  let addresses: string[];
  try { addresses = (await dns.lookup(hostname, { all: true })).map((x) => x.address); }
  catch { throw new SafeFetchRefused("blocked_url", "host DNS lookup failed"); }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new SafeFetchRefused("blocked_url", "host resolves to a private or reserved address");
  return addresses;
}

export async function validateOutboundUrl(raw: string, allowedHosts: string[], requireAllowlist = true) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SafeFetchRefused("invalid_url", "value is not a valid URL"); }
  if (url.protocol !== "https:") throw new SafeFetchRefused("blocked_url", "URL must use HTTPS");
  if (url.username || url.password) throw new SafeFetchRefused("blocked_url", "URL credentials are not allowed");
  if (url.port && url.port !== "443") throw new SafeFetchRefused("blocked_url", "non-standard ports are not allowed");
  if (!hostAllowed(url.hostname.toLowerCase(), allowedHosts, requireAllowlist)) throw new SafeFetchRefused("blocked_url", "host is not on the configured allowlist");
  await safeAddresses(url.hostname);
  return url;
}

function requestOnce(url: URL, address: string, cfg: SafeFetchConfig, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false; let total = 0; const chunks: Buffer[] = [];
    const finish = (err?: Error, result?: { status: number; headers: Record<string, string | undefined>; body: Buffer }) => { if (settled) return; settled = true; if (err) reject(err); else if (result) resolve(result); else reject(new Error("response ended without a result")); };
    const req = request({ protocol: "https:", hostname: address, port: 443, method: "GET", path: `${url.pathname || "/"}${url.search}`, servername: url.hostname, headers: { host: url.host, ...headers }, rejectUnauthorized: true, timeout: cfg.timeoutMs }, (res) => {
      const h: Record<string, string | undefined> = {}; for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v[0] : v;
      const advertised = Number(h["content-length"] ?? 0); if (advertised > cfg.maxBytes) { res.resume(); finish(new Error("response exceeds byte limit")); return; }
      res.on("data", (chunk: Buffer) => { total += chunk.length; if (total > cfg.maxBytes) { req.destroy(new Error("response exceeds byte limit")); return; } chunks.push(Buffer.from(chunk)); });
      res.on("end", () => finish(undefined, { status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks) }));
      res.on("error", (e) => finish(e));
    });
    req.on("timeout", () => req.destroy(new Error("fetch timeout")));
    req.on("error", (e) => finish(e));
    req.end();
  });
}

const DEFAULT_HEADERS = { accept: "application/json,text/html,application/xhtml+xml,text/plain;q=0.9", "user-agent": "HulettsPromotionsReceiptVerifier/1.0" };

export async function safeFetch(rawUrl: string, cfg: SafeFetchConfig, headers: Record<string, string> = {}): Promise<SafeFetchResult> {
  const requireAllowlist = cfg.requireAllowlist !== false;
  let url = await validateOutboundUrl(rawUrl, cfg.allowedHosts, requireAllowlist);
  let redirects = 0;
  for (;;) {
    const [address] = await safeAddresses(url.hostname);
    const res = await requestOnce(url, address, cfg, { ...DEFAULT_HEADERS, ...headers });
    if (REDIRECTS.has(res.status)) {
      if (redirects++ >= cfg.maxRedirects) throw new SafeFetchRefused("fetch_failed", "redirect limit exceeded");
      const location = res.headers.location; if (!location) throw new SafeFetchRefused("fetch_failed", "redirect omitted Location");
      url = await validateOutboundUrl(new URL(location, url).toString(), cfg.allowedHosts, requireAllowlist);
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new SafeFetchRefused("fetch_failed", `endpoint returned HTTP ${res.status}`);
    return { url, status: res.status, contentType: (res.headers["content-type"] ?? "").split(";", 1)[0].toLowerCase(), body: res.body };
  }
}

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Configuration schema. `doc` feeds .env.example and the preflight; secret values are never printed. */
export const CONFIG_DOC: Array<{ name: string; default: string; description: string; secret?: boolean }> = [
  { name: "ENVIRONMENT", default: "local", description: "local | test | staging | production. Recorded in the database on first migration; production enables activation gates and refuses simulators." },
  { name: "DATABASE_URL", default: "postgres://promo:promo@127.0.0.1:5432/promo", description: "PostgreSQL 16 connection string (one database per environment)." },
  { name: "DB_POOL_MAX", default: "10", description: "Maximum PostgreSQL connections for this process; size separately for API and worker services." },
  { name: "DB_STATEMENT_TIMEOUT_MS", default: "30000", description: "PostgreSQL statement timeout." },
  { name: "DB_CONNECTION_TIMEOUT_MS", default: "5000", description: "PostgreSQL connection acquisition timeout." },
  { name: "HOST", default: "127.0.0.1", description: "Bind address (0.0.0.0 on a PaaS)." },
  { name: "PORT", default: "8080", description: "HTTP port for API, webhook and console." },
  { name: "PUBLIC_BASE_URL", default: "", description: "Public HTTPS origin of this service (webhook URL, console links)." },
  { name: "CORS_ORIGINS", default: "", description: "Comma-separated browser origins allowed to call the API cross-origin. Empty (default) when the API serves the console itself." },
  { name: "HTTP_MAX_IN_FLIGHT", default: "200", description: "Maximum concurrent webhook/tRPC requests per API replica before load shedding." },
  { name: "TRUSTED_PROXY_HOPS", default: "1", description: "Number of trusted reverse proxies in front of this service. Sets how much of X-Forwarded-For is believed; 0 disables the header entirely. Never set it higher than the real hop count: everything beyond it is client-supplied." },
  { name: "HTTP_JSON_LIMIT", default: "512kb", description: "Maximum tRPC request body. The simulator upload route has its own larger limit." },
  { name: "HTTP_UPLOAD_LIMIT", default: "20mb", description: "Maximum body for the staff simulator upload route (non-production)." },
  { name: "MEDIA_ROOT", default: "./data/media", description: "Private receipt media root (filesystem adapter). Never inside the web root." },
  { name: "STORAGE_DRIVER", default: "fs", description: "fs | s3 (S3-compatible bucket via S3_* variables)." },
  { name: "S3_BUCKET", default: "", description: "Bucket for STORAGE_DRIVER=s3." },
  { name: "S3_PREFIX", default: "media", description: "Object-key prefix for receipt media." },
  { name: "S3_ENDPOINT", default: "", description: "S3-compatible endpoint (optional)." },
  { name: "S3_REGION", default: "us-east-1", description: "Bucket region." },
  { name: "S3_ACCESS_KEY_ID", default: "", description: "Storage credential.", secret: true },
  { name: "S3_SECRET_ACCESS_KEY", default: "", description: "Storage credential.", secret: true },
  { name: "BOOTSTRAP_ADMIN_EMAIL", default: "", description: "First technical administrator (created once, must change password)." },
  { name: "BOOTSTRAP_ADMIN_PASSWORD", default: "", description: "Temporary password for the bootstrap administrator (>= 14 chars).", secret: true },
  { name: "DATA_KEY", default: "", description: "Key material for field-level encryption (identity numbers, MFA secrets). Required outside local.", secret: true },
  { name: "AUDIT_SIGNING_KEY", default: "", description: "HMAC key for signed audit checkpoints exported in draw bundles.", secret: true },
  { name: "SESSION_HOURS", default: "12", description: "Staff session lifetime in hours." },
  { name: "DEFAULT_COUNTRY_CODE", default: "263", description: "Country code prefixed to local phone numbers (test assumption; D-04)." },
  { name: "WHATSAPP_PROVIDER", default: "simulator", description: "cloud-api (Meta WhatsApp Business Platform) | simulator (TEST ONLY; refused in production)." },
  { name: "META_GRAPH_VERSION", default: "v21.0", description: "Graph API version." },
  { name: "META_PHONE_NUMBER_ID", default: "", description: "Cloud API phone number id." },
  { name: "META_WABA_ID", default: "", description: "WhatsApp Business Account id." },
  { name: "META_ACCESS_TOKEN", default: "", description: "System-user access token.", secret: true },
  { name: "META_APP_SECRET", default: "", description: "App secret for X-Hub-Signature-256 verification.", secret: true },
  { name: "META_VERIFY_TOKEN", default: "", description: "Webhook verification token.", secret: true },
  { name: "OUTBOUND_ALLOWLIST", default: "", description: "Comma-separated designated test recipients; when set (non-production), messages to other numbers are held." },
  { name: "EXTRACTOR", default: "tesseract", description: "anthropic (vision model, real, needs key) | tesseract (real, offline OCR) | anthropic+tesseract (vision with local cross-check) | simulator (TEST ONLY; refused outside local/test)." },
  { name: "ANTHROPIC_API_KEY", default: "", description: "Anthropic API key for the vision extractor.", secret: true },
  { name: "ANTHROPIC_MODEL", default: "claude-sonnet-5", description: "Vision model id." },
  { name: "ANTHROPIC_BASE_URL", default: "", description: "Optional API base override." },
  { name: "EXTRACTION_TIMEOUT_MS", default: "45000", description: "Per-image extraction timeout." },
  { name: "FISCAL_PROVIDER", default: "none", description: "none | zimra-fdms (validate fiscal receipts against ZIMRA FDMS via FISCAL_BASE_URL) | simulator (TEST ONLY; refused outside local/test)." },
  { name: "FISCAL_BASE_URL", default: "", description: "HTTPS validation endpoint for fiscal receipts. Its host must also appear in FISCAL_ALLOWED_HOSTS." },
  { name: "FISCAL_API_KEY", default: "", description: "Bearer token for the fiscal validation endpoint, when one is required.", secret: true },
  { name: "FISCAL_ALLOWED_HOSTS", default: "", description: "REQUIRED comma-separated host allowlist for fiscal lookups. Empty means fiscal verification is not configured and every receipt takes the OCR path; it never means 'any host'." },
  { name: "FISCAL_REQUIRED", default: "false", description: "Treat an unavailable fiscal provider as a readiness failure. Leave false to degrade to OCR rather than stop intake." },
  { name: "FISCAL_TIMEOUT_MS", default: "8000", description: "Per-hop HTTPS timeout for a fiscal validation request." },
  { name: "FISCAL_MAX_BYTES", default: "1000000", description: "Maximum fiscal validation response size." },
  { name: "FISCAL_MAX_REDIRECTS", default: "3", description: "Maximum HTTPS redirect hops for a fiscal validation request." },
  { name: "FISCAL_CONTRACT_MODE", default: "html", description: "Shape of the FDMS validation response: html (the real ZIMRA verification page, reached through its 'Review Invoice' form) | json (a structured body, e.g. a vendor gateway). A JSON body is mapped as JSON whichever is set; this decides only whether an HTML page is read or refused." },
  { name: "FISCAL_QR_LAYOUT", default: "10,4,10,16", description: "Widths of the packed ZIMRA QR tail: deviceId,fiscalDayNo,receiptGlobalNo,verificationCode. Confirm against the published FDMS specification before production; a wrong width mis-identifies every receipt." },
  { name: "AI_VERIFICATION_ENABLED", default: "false", description: "Run advisory AI receipt verification after deterministic extraction." },
  { name: "AI_VERIFICATION_REQUIRED", default: "false", description: "Treat missing AI verification as a hold/review condition." },
  { name: "AI_VERIFICATION_PROVIDER", default: "openai", description: "openai | anthropic provider used for receipt verification." },
  { name: "AI_VERIFICATION_MODEL", default: "gpt-4o-mini", description: "Vision model used for receipt verification." },
  { name: "OPENAI_API_KEY", default: "", description: "OpenAI API key for receipt verification.", secret: true },
  { name: "OPENAI_BASE_URL", default: "", description: "Optional OpenAI-compatible API base override." },
  { name: "AI_VERIFICATION_TIMEOUT_MS", default: "60000", description: "AI verification request timeout." },
  { name: "AI_VERIFICATION_MIN_PROBABILITY", default: "0.98", description: "Uncalibrated model signal below this value is held for review; it is not a calibrated probability." },
  { name: "CRM_PROVIDER", default: "none", description: "none | http-contract (generic JSON contract; see docs/integrations/crm.md) — vendor adapter is a client decision (D-19)." },
  { name: "CRM_BASE_URL", default: "", description: "Base URL of the CRM contract endpoint." },
  { name: "CRM_TOKEN", default: "", description: "Bearer token for the CRM endpoint.", secret: true },
  { name: "CRM_TIMEOUT_MS", default: "10000", description: "CRM call timeout." },
  { name: "REVIEW_SLA_HOURS", default: "24", description: "Review service target used for queue ageing and alerts (test value; D-14)." },
  { name: "CLAIM_WINDOW_DAYS", default: "7", description: "Winner claim deadline after notification (test value; D-17)." },
  { name: "RETENTION_MEDIA_DAYS", default: "90", description: "Raw receipt image retention (D-22 pending)." },
  { name: "WORKER_MODE", default: "embedded", description: "embedded (worker loop inside the API process) | external (run `npm run worker` separately) | off." },
  { name: "WORKER_POLL_MS", default: "1500", description: "Worker poll interval." },
  { name: "WORKER_EVENT_BATCH", default: "25", description: "Maximum inbound events claimed per worker tick." },
  { name: "WORKER_JOB_BATCH", default: "10", description: "Maximum jobs claimed per worker tick." },
  { name: "LOG_LEVEL", default: "info", description: "pino log level." },
  { name: "SEED_ON_BOOT", default: "false", description: "Non-production only: seed the sample campaign on start if absent." },
];

/** Widths of the packed fiscal QR tail. A malformed value falls back to the documented default rather than producing silently misaligned identifiers. */
function parseQrLayout(v: string) {
  const parts = String(v ?? "").split(",").map((x) => Number(x.trim()));
  const ok = parts.length === 4 && parts.every((n) => Number.isInteger(n) && n > 0 && n <= 64);
  const [deviceId, fiscalDayNo, receiptGlobalNo, verificationCode] = ok ? parts : [10, 4, 10, 16];
  return { deviceId, fiscalDayNo, receiptGlobalNo, verificationCode };
}
const boundedInt = (fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(fallback);
const Env = z.object({
  ENVIRONMENT: z.enum(["local", "test", "staging", "production"]).default("local"),
  DATABASE_URL: z.string().default("postgres://promo:promo@127.0.0.1:5432/promo"),
  DB_POOL_MAX: boundedInt(10, 1, 100), DB_STATEMENT_TIMEOUT_MS: boundedInt(30_000, 1_000, 120_000), DB_CONNECTION_TIMEOUT_MS: boundedInt(5_000, 500, 30_000),
  HOST: z.string().default("127.0.0.1"), PORT: z.coerce.number().int().nonnegative().default(8080), PUBLIC_BASE_URL: z.string().default(""),
  CORS_ORIGINS: z.string().default("").transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)), HTTP_MAX_IN_FLIGHT: boundedInt(200, 10, 10_000), TRUSTED_PROXY_HOPS: boundedInt(1, 0, 5), HTTP_JSON_LIMIT: z.string().default("512kb"), HTTP_UPLOAD_LIMIT: z.string().default("20mb"),
  MEDIA_ROOT: z.string().default("./data/media"), STORAGE_DRIVER: z.enum(["fs", "s3"]).default("fs"), S3_BUCKET: z.string().default(""), S3_PREFIX: z.string().default("media"), S3_ENDPOINT: z.string().default(""), S3_REGION: z.string().default("us-east-1"), S3_ACCESS_KEY_ID: z.string().default(""), S3_SECRET_ACCESS_KEY: z.string().default(""),
  BOOTSTRAP_ADMIN_EMAIL: z.string().default(""), BOOTSTRAP_ADMIN_PASSWORD: z.string().default(""), DATA_KEY: z.string().default(""), AUDIT_SIGNING_KEY: z.string().default(""), SESSION_HOURS: z.coerce.number().positive().default(12),
  DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,3}$/).default("263"), WHATSAPP_PROVIDER: z.enum(["cloud-api", "simulator"]).default("simulator"), META_GRAPH_VERSION: z.string().default("v21.0"), META_PHONE_NUMBER_ID: z.string().default(""), META_WABA_ID: z.string().default(""), META_ACCESS_TOKEN: z.string().default(""), META_APP_SECRET: z.string().default(""), META_VERIFY_TOKEN: z.string().default(""), OUTBOUND_ALLOWLIST: z.string().default(""),
  EXTRACTOR: z.enum(["anthropic", "tesseract", "anthropic+tesseract", "simulator"]).default("tesseract"), ANTHROPIC_API_KEY: z.string().default(""), ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"), ANTHROPIC_BASE_URL: z.string().default(""), OPENAI_API_KEY: z.string().default(""), OPENAI_BASE_URL: z.string().default(""), EXTRACTION_TIMEOUT_MS: z.coerce.number().positive().default(45_000), FISCAL_PROVIDER: z.enum(["none", "zimra-fdms", "simulator"]).default("none"), FISCAL_BASE_URL: z.string().default(""), FISCAL_API_KEY: z.string().default(""), FISCAL_ALLOWED_HOSTS: z.string().default(""), FISCAL_REQUIRED: z.string().default("false"), FISCAL_TIMEOUT_MS: boundedInt(8_000, 1_000, 30_000), FISCAL_MAX_BYTES: boundedInt(1_000_000, 16_384, 10_000_000), FISCAL_MAX_REDIRECTS: boundedInt(3, 0, 5), FISCAL_QR_LAYOUT: z.string().default("10,4,10,16"), FISCAL_CONTRACT_MODE: z.enum(["html", "json"]).default("html"), AI_VERIFICATION_PROVIDER: z.enum(["openai", "anthropic"]).default("openai"), AI_VERIFICATION_ENABLED: z.string().default("false"), AI_VERIFICATION_REQUIRED: z.string().default("false"), AI_VERIFICATION_MODEL: z.string().default("gpt-4o-mini"), AI_VERIFICATION_TIMEOUT_MS: boundedInt(60_000, 5_000, 120_000), AI_VERIFICATION_MIN_PROBABILITY: z.coerce.number().min(0).max(1).default(0.98),
  CRM_PROVIDER: z.enum(["none", "http-contract"]).default("none"), CRM_BASE_URL: z.string().default(""), CRM_TOKEN: z.string().default(""), CRM_TIMEOUT_MS: z.coerce.number().positive().default(10_000), REVIEW_SLA_HOURS: z.coerce.number().positive().default(24), CLAIM_WINDOW_DAYS: z.coerce.number().positive().default(7), RETENTION_MEDIA_DAYS: z.coerce.number().positive().default(90),
  WORKER_MODE: z.enum(["embedded", "external", "off"]).default("embedded"), WORKER_POLL_MS: boundedInt(1_500, 250, 60_000), WORKER_EVENT_BATCH: boundedInt(25, 1, 200), WORKER_JOB_BATCH: boundedInt(10, 1, 100), LOG_LEVEL: z.string().default("info"), SEED_ON_BOOT: z.string().default("false"),
});
export type Config = z.infer<typeof Env> & { isProduction: boolean; isLocal: boolean; outboundAllowlist: string[]; fiscalAllowedHosts: string[]; fiscalEnabled: boolean; fiscalRequired: boolean; fiscalQrLayout: { deviceId: number; fiscalDayNo: number; receiptGlobalNo: number; verificationCode: number }; aiVerificationEnabled: boolean; aiVerificationRequired: boolean };

export function loadDotEnv(file = process.env.ENV_FILE ?? ".env") {
  let text: string; try { text = fs.readFileSync(path.resolve(file), "utf8"); } catch { return 0; }
  let n = 0; for (const raw of text.split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith("#")) continue; const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (process.env[m[1]] === undefined) { process.env[m[1]] = v; n++; } }
  return n;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadDotEnv(); const parsed = Env.safeParse(env); if (!parsed.success) throw new Error(`configuration invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`); const c = parsed.data;
  return { ...c, isProduction: c.ENVIRONMENT === "production", isLocal: c.ENVIRONMENT === "local", outboundAllowlist: c.OUTBOUND_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean), fiscalAllowedHosts: c.FISCAL_ALLOWED_HOSTS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean), fiscalEnabled: c.FISCAL_PROVIDER !== "none", fiscalRequired: c.FISCAL_REQUIRED.toLowerCase() === "true", fiscalQrLayout: parseQrLayout(c.FISCAL_QR_LAYOUT), aiVerificationEnabled: c.AI_VERIFICATION_ENABLED.toLowerCase() === "true", aiVerificationRequired: c.AI_VERIFICATION_REQUIRED.toLowerCase() === "true" };
}
export function validateConfig(c: Config): string[] {
  const p: string[] = [];
  if (!c.isLocal) { if (!c.DATA_KEY || c.DATA_KEY.length < 24) p.push("DATA_KEY must be set (>= 24 chars) outside local"); if (!c.AUDIT_SIGNING_KEY) p.push("AUDIT_SIGNING_KEY must be set outside local"); if (c.BOOTSTRAP_ADMIN_EMAIL && c.BOOTSTRAP_ADMIN_PASSWORD.length < 14) p.push("BOOTSTRAP_ADMIN_PASSWORD must be >= 14 chars"); }
  if (c.isProduction) { if (c.WHATSAPP_PROVIDER !== "cloud-api") p.push("production requires WHATSAPP_PROVIDER=cloud-api"); if (c.EXTRACTOR === "simulator") p.push("EXTRACTOR=simulator is forbidden in production"); if (c.SEED_ON_BOOT === "true") p.push("SEED_ON_BOOT is forbidden in production"); if (c.STORAGE_DRIVER !== "s3") p.push("production requires STORAGE_DRIVER=s3 for durable media"); if (!c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY) p.push("production s3 storage requires S3 credentials"); }
  else if (c.ENVIRONMENT === "staging" && c.EXTRACTOR === "simulator") p.push("EXTRACTOR=simulator is forbidden in staging");
  if (c.WHATSAPP_PROVIDER === "cloud-api" && (!c.META_ACCESS_TOKEN || !c.META_APP_SECRET || !c.META_VERIFY_TOKEN || !c.META_PHONE_NUMBER_ID)) p.push("cloud-api requires META_ACCESS_TOKEN, META_APP_SECRET, META_VERIFY_TOKEN, META_PHONE_NUMBER_ID");
  if (c.EXTRACTOR.startsWith("anthropic") && !c.ANTHROPIC_API_KEY) p.push("anthropic extractor requires ANTHROPIC_API_KEY");
  if (c.aiVerificationRequired && !c.aiVerificationEnabled) p.push("AI_VERIFICATION_REQUIRED requires AI_VERIFICATION_ENABLED=true");
  // The allowlist is the control, not a refinement of it: without it the
  // adapter reports not_configured and receipts fall back to OCR. Saying so at
  // startup beats discovering it from a fiscal-status metric that is all zeroes.
  if (c.FISCAL_PROVIDER === "zimra-fdms" && !c.FISCAL_BASE_URL) p.push("FISCAL_PROVIDER=zimra-fdms requires FISCAL_BASE_URL");
  if (c.FISCAL_PROVIDER === "zimra-fdms" && !c.fiscalAllowedHosts.length) p.push("FISCAL_PROVIDER=zimra-fdms requires FISCAL_ALLOWED_HOSTS (an empty allowlist disables fiscal verification; it never permits arbitrary hosts)");
  if (c.FISCAL_PROVIDER === "zimra-fdms" && c.FISCAL_BASE_URL) { try { const h = new URL(c.FISCAL_BASE_URL).hostname.toLowerCase(); if (!c.fiscalAllowedHosts.some((a) => h === a || h.endsWith(`.${a}`))) p.push("FISCAL_BASE_URL host must appear in FISCAL_ALLOWED_HOSTS"); } catch { p.push("FISCAL_BASE_URL must be an absolute HTTPS URL"); } }
  if (c.FISCAL_PROVIDER === "simulator" && !["local", "test"].includes(c.ENVIRONMENT)) p.push("FISCAL_PROVIDER=simulator is only allowed in local/test");
  if (c.fiscalRequired && !c.fiscalEnabled) p.push("FISCAL_REQUIRED requires a FISCAL_PROVIDER");
  if (c.aiVerificationEnabled && c.AI_VERIFICATION_PROVIDER === "anthropic" && !c.ANTHROPIC_API_KEY) p.push("AI_VERIFICATION_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
  if (c.aiVerificationEnabled && c.AI_VERIFICATION_PROVIDER === "openai" && !c.OPENAI_API_KEY) p.push("AI_VERIFICATION_PROVIDER=openai requires OPENAI_API_KEY");
  if (c.CRM_PROVIDER === "http-contract" && !c.CRM_BASE_URL) p.push("http-contract CRM requires CRM_BASE_URL");
  if (c.STORAGE_DRIVER === "s3" && (!c.S3_BUCKET || !c.S3_REGION)) p.push("s3 storage requires S3_BUCKET and S3_REGION");
  return p;
}

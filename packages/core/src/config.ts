import { z } from "zod";

/** Configuration schema. `doc` feeds .env.example and the preflight; secret values are never printed. */
export const CONFIG_DOC: Array<{ name: string; default: string; description: string; secret?: boolean }> = [
  { name: "ENVIRONMENT", default: "local", description: "local | test | staging | production. Recorded in the database on first migration; production enables activation gates and refuses simulators." },
  { name: "DATABASE_URL", default: "postgres://promo:promo@127.0.0.1:5432/promo", description: "PostgreSQL 16 connection string (one database per environment)." },
  { name: "HOST", default: "127.0.0.1", description: "Bind address (0.0.0.0 on a PaaS)." },
  { name: "PORT", default: "8080", description: "HTTP port for API, webhook and console." },
  { name: "PUBLIC_BASE_URL", default: "", description: "Public HTTPS origin of this service (webhook URL, console links)." },
  { name: "MEDIA_ROOT", default: "./data/media", description: "Private receipt media root (filesystem adapter). Never inside the web root." },
  { name: "STORAGE_DRIVER", default: "fs", description: "fs | s3 (S3-compatible bucket via S3_* variables)." },
  { name: "S3_BUCKET", default: "", description: "Bucket for STORAGE_DRIVER=s3." },
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
  { name: "CRM_PROVIDER", default: "none", description: "none | http-contract (generic JSON contract; see docs/integrations/crm.md) — vendor adapter is a client decision (D-19)." },
  { name: "CRM_BASE_URL", default: "", description: "Base URL of the CRM contract endpoint." },
  { name: "CRM_TOKEN", default: "", description: "Bearer token for the CRM endpoint.", secret: true },
  { name: "CRM_TIMEOUT_MS", default: "10000", description: "CRM call timeout." },
  { name: "REVIEW_SLA_HOURS", default: "24", description: "Review service target used for queue ageing and alerts (test value; D-14)." },
  { name: "CLAIM_WINDOW_DAYS", default: "7", description: "Winner claim deadline after notification (test value; D-17)." },
  { name: "RETENTION_MEDIA_DAYS", default: "90", description: "Raw receipt image retention (D-22 pending)." },
  { name: "WORKER_MODE", default: "embedded", description: "embedded (worker loop inside the API process) | external (run `npm run worker` separately) | off." },
  { name: "LOG_LEVEL", default: "info", description: "pino log level." },
  { name: "SEED_ON_BOOT", default: "false", description: "Non-production only: seed the sample campaign on start if absent." },
];

const Env = z.object({
  ENVIRONMENT: z.enum(["local", "test", "staging", "production"]).default("local"),
  DATABASE_URL: z.string().default("postgres://promo:promo@127.0.0.1:5432/promo"),
  HOST: z.string().default("127.0.0.1"), PORT: z.coerce.number().int().nonnegative().default(8080), PUBLIC_BASE_URL: z.string().default(""),
  MEDIA_ROOT: z.string().default("./data/media"), STORAGE_DRIVER: z.enum(["fs", "s3"]).default("fs"),
  S3_BUCKET: z.string().default(""), S3_ENDPOINT: z.string().default(""), S3_REGION: z.string().default("us-east-1"), S3_ACCESS_KEY_ID: z.string().default(""), S3_SECRET_ACCESS_KEY: z.string().default(""),
  BOOTSTRAP_ADMIN_EMAIL: z.string().default(""), BOOTSTRAP_ADMIN_PASSWORD: z.string().default(""),
  DATA_KEY: z.string().default(""), AUDIT_SIGNING_KEY: z.string().default(""), SESSION_HOURS: z.coerce.number().positive().default(12),
  DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,3}$/).default("263"),
  WHATSAPP_PROVIDER: z.enum(["cloud-api", "simulator"]).default("simulator"), META_GRAPH_VERSION: z.string().default("v21.0"), META_PHONE_NUMBER_ID: z.string().default(""), META_WABA_ID: z.string().default(""), META_ACCESS_TOKEN: z.string().default(""), META_APP_SECRET: z.string().default(""), META_VERIFY_TOKEN: z.string().default(""),
  OUTBOUND_ALLOWLIST: z.string().default(""),
  EXTRACTOR: z.enum(["anthropic", "tesseract", "anthropic+tesseract", "simulator"]).default("tesseract"), ANTHROPIC_API_KEY: z.string().default(""), ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"), ANTHROPIC_BASE_URL: z.string().default(""), EXTRACTION_TIMEOUT_MS: z.coerce.number().positive().default(45_000),
  CRM_PROVIDER: z.enum(["none", "http-contract"]).default("none"), CRM_BASE_URL: z.string().default(""), CRM_TOKEN: z.string().default(""), CRM_TIMEOUT_MS: z.coerce.number().positive().default(10_000),
  REVIEW_SLA_HOURS: z.coerce.number().positive().default(24), CLAIM_WINDOW_DAYS: z.coerce.number().positive().default(7), RETENTION_MEDIA_DAYS: z.coerce.number().positive().default(90),
  WORKER_MODE: z.enum(["embedded", "external", "off"]).default("embedded"), LOG_LEVEL: z.string().default("info"), SEED_ON_BOOT: z.string().default("false"),
});
export type Config = z.infer<typeof Env> & { isProduction: boolean; isLocal: boolean; outboundAllowlist: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`configuration invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const c = parsed.data;
  return { ...c, isProduction: c.ENVIRONMENT === "production", isLocal: c.ENVIRONMENT === "local", outboundAllowlist: c.OUTBOUND_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean) };
}

/** Fail-fast rules per environment. Returns problems (empty = ok). */
export function validateConfig(c: Config): string[] {
  const p: string[] = [];
  if (!c.isLocal) {
    if (!c.DATA_KEY || c.DATA_KEY.length < 24) p.push("DATA_KEY must be set (>= 24 chars) outside local");
    if (!c.AUDIT_SIGNING_KEY) p.push("AUDIT_SIGNING_KEY must be set outside local");
    if (c.BOOTSTRAP_ADMIN_EMAIL && c.BOOTSTRAP_ADMIN_PASSWORD.length < 14) p.push("BOOTSTRAP_ADMIN_PASSWORD must be >= 14 chars");
  }
  if (c.isProduction) {
    if (c.WHATSAPP_PROVIDER !== "cloud-api") p.push("production requires WHATSAPP_PROVIDER=cloud-api");
    if (c.EXTRACTOR === "simulator") p.push("EXTRACTOR=simulator is forbidden in production");
    if (c.ENVIRONMENT === "production" && c.SEED_ON_BOOT === "true") p.push("SEED_ON_BOOT is forbidden in production");
  } else if (c.ENVIRONMENT === "staging" && c.EXTRACTOR === "simulator") p.push("EXTRACTOR=simulator is forbidden in staging");
  if (c.WHATSAPP_PROVIDER === "cloud-api" && (!c.META_ACCESS_TOKEN || !c.META_APP_SECRET || !c.META_VERIFY_TOKEN || !c.META_PHONE_NUMBER_ID)) p.push("cloud-api requires META_ACCESS_TOKEN, META_APP_SECRET, META_VERIFY_TOKEN, META_PHONE_NUMBER_ID");
  if (c.EXTRACTOR.startsWith("anthropic") && !c.ANTHROPIC_API_KEY) p.push("anthropic extractor requires ANTHROPIC_API_KEY");
  if (c.CRM_PROVIDER === "http-contract" && !c.CRM_BASE_URL) p.push("http-contract CRM requires CRM_BASE_URL");
  if (c.STORAGE_DRIVER === "s3" && !c.S3_BUCKET) p.push("s3 storage requires S3_BUCKET");
  return p;
}

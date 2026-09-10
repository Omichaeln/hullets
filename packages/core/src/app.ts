import { schema, createPool, createDb, migrate, type Db } from "@promo/db";
import { eq } from "drizzle-orm";
import { loadConfig, validateConfig, type Config } from "./config.ts";
import { createLogger, silentLogger, type Logger } from "./util/log.ts";
import { AuditService } from "./audit.ts";
import { AuthService } from "./auth/service.ts";
import { CampaignService } from "./campaign/service.ts";
import { ParticipantService } from "./participant/service.ts";
import { ConversationEngine } from "./conversation/engine.ts";
import { FsStorage, UnavailableStorage, type StorageDriver } from "./media/storage.ts";
import { MediaService } from "./media/service.ts";
import { createExtractor, type Extractor } from "./extraction/index.ts";
import { ReceiptPipeline } from "./receipt/pipeline.ts";
import { DrawService } from "./draw/service.ts";
import { WinnerService } from "./winner/service.ts";
import { CrmService, HttpContractAdapter, NoCrmAdapter, type CrmAdapter } from "./crm/index.ts";
import { QueueService } from "./ops/queue.ts";
import { OutboxService } from "./ops/outbox.ts";
import { OpsSignals } from "./ops/alerts.ts";
import { ReportService } from "./ops/reports.ts";
import { Worker } from "./ops/worker.ts";
import { CloudApiTransport } from "./whatsapp/cloud-api.ts";
import { SimulatorTransport } from "./whatsapp/simulator.ts";
import type { WhatsAppTransport } from "./whatsapp/transport.ts";
import path from "node:path";

export type App = Awaited<ReturnType<typeof createApp>>;
/** Wire the modular monolith. Options let tests inject providers; production wiring comes from configuration only. */
export async function createApp(opts: { config?: Config; log?: Logger; transport?: WhatsAppTransport; extractor?: Extractor; crmAdapter?: CrmAdapter; storage?: StorageDriver; migrate?: boolean } = {}) {
  const cfg = opts.config ?? loadConfig();
  const problems = validateConfig(cfg); if (problems.length) throw new Error(`configuration invalid: ${problems.join("; ")}`);
  const log = opts.log ?? (cfg.ENVIRONMENT === "test" ? silentLogger() : createLogger(cfg.LOG_LEVEL));
  const pool = createPool(cfg.DATABASE_URL); const db: Db = createDb(pool);
  if (opts.migrate !== false) await migrate(db);
  await db.insert(schema.schemaMeta).values({ key: "environment", value: cfg.ENVIRONMENT }).onConflictDoNothing();
  const [envRow] = await db.select().from(schema.schemaMeta).where(eq(schema.schemaMeta.key, "environment")); const environment = envRow?.value ?? cfg.ENVIRONMENT;
  if (environment !== cfg.ENVIRONMENT) log.warn({ database: environment, config: cfg.ENVIRONMENT }, "database environment differs from configuration; the database value governs");

  const audit = new AuditService(db, cfg.AUDIT_SIGNING_KEY);
  const auth = new AuthService(db, audit, cfg.DATA_KEY, cfg.SESSION_HOURS);
  if (cfg.BOOTSTRAP_ADMIN_EMAIL && cfg.BOOTSTRAP_ADMIN_PASSWORD) await auth.bootstrap(cfg.BOOTSTRAP_ADMIN_EMAIL, cfg.BOOTSTRAP_ADMIN_PASSWORD);
  const campaigns = new CampaignService(db, audit);
  const participants = new ParticipantService(db, audit, cfg.DATA_KEY, cfg.DEFAULT_COUNTRY_CODE);
  const storage = opts.storage ?? (cfg.STORAGE_DRIVER === "fs" ? new FsStorage(path.resolve(cfg.MEDIA_ROOT)) : new UnavailableStorage(cfg.STORAGE_DRIVER));
  const media = new MediaService(db, storage, cfg.RETENTION_MEDIA_DAYS);
  const extractor = opts.extractor ?? createExtractor(cfg);
  const signals = new OpsSignals(db); const queue = new QueueService(db); const outbox = new OutboxService(db);
  const crmAdapter = opts.crmAdapter ?? (cfg.CRM_PROVIDER === "http-contract" ? new HttpContractAdapter(cfg.CRM_BASE_URL, cfg.CRM_TOKEN, cfg.CRM_TIMEOUT_MS) : new NoCrmAdapter());
  const crm = new CrmService(db, crmAdapter, environment, signals); participants.crm = crm;
  const pipeline = new ReceiptPipeline(db, { media, extractor, campaigns, participants, audit, outbox, queue, crm, alerts: signals, reviewSlaHours: cfg.REVIEW_SLA_HOURS });
  const winners = new WinnerService(db, { campaigns, participants, audit, outbox, crm, claimDays: cfg.CLAIM_WINDOW_DAYS });
  const draws = new DrawService(db, { campaigns, audit });
  const conversation = new ConversationEngine(db, { campaigns, participants, intake: pipeline, winners, crm, audit });
  const transport: WhatsAppTransport = opts.transport ?? (cfg.WHATSAPP_PROVIDER === "cloud-api" ? new CloudApiTransport({ graphVersion: cfg.META_GRAPH_VERSION, phoneNumberId: cfg.META_PHONE_NUMBER_ID, accessToken: cfg.META_ACCESS_TOKEN, appSecret: cfg.META_APP_SECRET, verifyToken: cfg.META_VERIFY_TOKEN, defaultCountryCode: cfg.DEFAULT_COUNTRY_CODE }) : new SimulatorTransport());
  if (environment === "production" && transport.mode !== "configured") throw new Error("a simulated transport is forbidden in production");
  const reports = new ReportService(db);
  const worker = new Worker({ db, cfg, environment, queue, outbox, crm, transport, conversation, pipeline, winners, media, campaigns, signals, audit, log });
  return { cfg, environment, log, pool, db, audit, auth, campaigns, participants, media, storage, extractor, signals, queue, outbox, crm, pipeline, winners, draws, conversation, transport, reports, worker,
    async close() { worker.stop(); await extractor.close?.(); await pool.end(); } };
}

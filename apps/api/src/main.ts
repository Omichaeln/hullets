import { createApp } from "@promo/core";
import { createHttpServer } from "./server.ts";

const workerOnly = process.argv.includes("--worker");
const app = await createApp();
if (app.cfg.SEED_ON_BOOT === "true" && app.environment !== "production") {
  const { ensureSampleCampaign } = await import("../../../tools/lib/sample.ts");
  const r = await ensureSampleCampaign(app);
  app.log.info({ seeded: r.seeded, campaign: r.campaign.code }, "sample campaign");
}

if (workerOnly) {
  app.worker.start();
  app.log.info({ mode: "external", pollMs: app.cfg.WORKER_POLL_MS }, "hullets worker started");
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ sig }, "worker shutting down");
    app.worker.stop();
    await app.close();
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stop(sig));
} else {
  const http = createHttpServer(app);
  const server = http.listen(app.cfg.PORT, app.cfg.HOST, () => app.log.info({ host: app.cfg.HOST, port: app.cfg.PORT, environment: app.environment, transport: app.transport.provider, extractor: app.extractor.name, worker: app.cfg.WORKER_MODE, release: process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown" }, "hullets api listening"));
  if (app.cfg.WORKER_MODE === "embedded") app.worker.start();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => {
    app.log.info({ sig }, "api shutting down");
    server.close(() => void app.close().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8_000).unref();
  });
}

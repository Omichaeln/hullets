# Deploy, upgrade, rollback

## First deployment
1. Provision PostgreSQL 16 (managed), a storage volume or S3 bucket, a TLS-terminating reverse proxy, and one container/VM with Node 22.
2. Set the environment from `.env.example`; production requires `ENVIRONMENT=production`, `DATA_KEY`, `AUDIT_SIGNING_KEY`, `BOOTSTRAP_ADMIN_*`, `WHATSAPP_PROVIDER=cloud-api` with the `META_*` values, `EXTRACTOR` (`tesseract`, `anthropic` or `anthropic+tesseract`) and, if used, `CRM_*`. The simulator transport/extractor is refused in production.
3. `npm ci --legacy-peer-deps && npm run console:build && npm run db:migrate && npm run preflight` (exit 0 required).
4. Start `npm start` (embedded worker) or `WORKER_MODE=external npm start` plus `npm run worker`.
5. Point the Meta webhook at `https://<host>/webhooks/whatsapp` with `META_VERIFY_TOKEN`; run `npm run smoke` with `SMOKE_BASE_URL`.
6. Sign in as the bootstrap admin, change the password, enable MFA, create the client's staff users (Access), hand over temporary passwords out of band.

## Railway

`railway.json` selects the Nixpacks builder with `npm run console:build && npm run typecheck` as the build command and `npm run -s db:migrate && npm run start` as the start command, so the console bundle is produced at build time and the migrations run (idempotently) before every start. The committed `.npmrc` (`legacy-peer-deps`, because Vite 8 at the root and the console's Vite 7 toolchain disagree on a peer range) and `.node-version` (22) make Railway's install match a local `npm ci`; a plain `npm ci` without them rejects the lockfile. Nixpacks needs no system packages: OCR uses `tesseract.js` (WASM), and image handling uses `sharp`'s prebuilt binaries.

Deploy one service from the repository root. Railway's monorepo detection offers a service per workspace (`@promo/api`, `@promo/console`); only the root service is needed because the API serves the built console, so delete any extra workspace service rather than configuring it.

The `Dockerfile` remains for hosts that build images (or for Railway with `"builder": "DOCKERFILE"`); it produces the same runtime, with `HOST=0.0.0.0` baked in.

1. Create a PostgreSQL service in the Railway project and reference its connection string as `DATABASE_URL` on the app service (`${{Postgres.DATABASE_URL}}`).
2. Set the variables from `.env.example`. Minimum for a first boot: `ENVIRONMENT=staging` (or `production`), `DATA_KEY`, `AUDIT_SIGNING_KEY`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `MEDIA_ROOT=/app/data/media`. Set `HOST=0.0.0.0` explicitly (the default bind is loopback, which fails Railway's health check); `PORT` is injected by Railway. Leave `WHATSAPP_PROVIDER=simulator` and `EXTRACTOR=tesseract` until the Meta and extractor credentials exist; the simulator is refused only when `ENVIRONMENT=production`. QR fallback is enabled by default but should be host-allowlisted after the fiscal platform is approved. Set `AI_VERIFICATION_PROVIDER=openai` and keep `AI_VERIFICATION_ENABLED=false` until a labelled calibration set, budget, and risk owner approve enabling the advisory verifier; it uses `OPENAI_API_KEY` and never replaces deterministic eligibility.
3. Attach a volume at `/app/data` so receipt images survive redeploys (or set `STORAGE_DRIVER` to an object store when one is configured).
4. Deploy. The start command runs the migrations (idempotent) and then the API with the embedded worker; the health check is `/health/live`.
5. Point the Meta webhook at `https://<railway-domain>/webhooks/whatsapp` when the transport is configured; run `SMOKE_BASE_URL=https://<railway-domain> npm run smoke` from a checkout.

Sample data on a hosted environment: run `npm run seed` once from a Railway shell (or set `SEED_ON_BOOT=true` for the sample campaign only; the fixture journeys still need `npm run seed`).

## Upgrade
1. Back up (`backup-restore.md`).
2. Deploy the new image; `npm run db:migrate` (migrations are additive and idempotent; the migrator table is `drizzle.drizzle_migrations`).
3. Restart API and worker; `npm run smoke`; check Ops → Health and Alerts.

## Rollback
- Application: redeploy the previous image; migrations from this repository never drop or rename columns within a release, so the previous version runs against the newer schema.
- Data: only from a backup, see `backup-restore.md`; never edit ledger rows by hand.

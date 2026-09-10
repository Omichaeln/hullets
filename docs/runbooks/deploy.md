# Deploy, upgrade, rollback

## First deployment
1. Provision PostgreSQL 16 (managed), a storage volume or S3 bucket, a TLS-terminating reverse proxy, and one container/VM with Node 22.
2. Set the environment from `.env.example`; production requires `ENVIRONMENT=production`, `DATA_KEY`, `AUDIT_SIGNING_KEY`, `BOOTSTRAP_ADMIN_*`, `WHATSAPP_PROVIDER=cloud-api` with the `META_*` values, `EXTRACTOR` (`tesseract`, `anthropic` or `anthropic+tesseract`) and, if used, `CRM_*`. The simulator transport/extractor is refused in production.
3. `npm ci --legacy-peer-deps && npm run console:build && npm run db:migrate && npm run preflight` (exit 0 required).
4. Start `npm start` (embedded worker) or `WORKER_MODE=external npm start` plus `npm run worker`.
5. Point the Meta webhook at `https://<host>/webhooks/whatsapp` with `META_VERIFY_TOKEN`; run `npm run smoke` with `SMOKE_BASE_URL`.
6. Sign in as the bootstrap admin, change the password, enable MFA, create the client's staff users (Access), hand over temporary passwords out of band.

## Upgrade
1. Back up (`backup-restore.md`).
2. Deploy the new image; `npm run db:migrate` (migrations are additive and idempotent; the migrator table is `drizzle.drizzle_migrations`).
3. Restart API and worker; `npm run smoke`; check Ops → Health and Alerts.

## Rollback
- Application: redeploy the previous image; migrations from this repository never drop or rename columns within a release, so the previous version runs against the newer schema.
- Data: only from a backup, see `backup-restore.md`; never edit ledger rows by hand.

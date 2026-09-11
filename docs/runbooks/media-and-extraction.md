# Extractor outage and delayed submissions

Alerts: `submission.stuck` (six failed attempts), readiness/health showing the extractor as not ok.

1. Ops → Health → Receipt extractor: mode and error. For `anthropic`, check the key, quota and `ANTHROPIC_BASE_URL`; for `tesseract`, check CPU/memory and `EXTRACTION_TIMEOUT_MS`.
2. Submissions in `delayed` retry on a schedule (1, 2, 4, 8, 16, 20 minutes); participants have been told "taking longer". Once the provider recovers they clear automatically.
3. A stuck submission (six attempts) needs a manual reprocess after the fix (Submissions → open → Reprocess, with a reason) or a reviewer decision.
4. Storage: `storage` not ok means images cannot be saved; intake returns a "please try again" message and nothing is lost on the provider side (Meta retries the webhook if we returned 503). Fix the volume/bucket and watch the backlog drain.
5. Switching provider (`EXTRACTOR`) is a configuration change and a restart; the provider and model are recorded on every attempt.

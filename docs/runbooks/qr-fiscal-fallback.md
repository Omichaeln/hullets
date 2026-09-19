# QR fiscal-receipt fallback runbook

## What the feature does

The receipt worker attempts QR/barcode fallback when the configured OCR result is incomplete, low-confidence, or not a receipt. A participant may therefore send either a full receipt photograph or a clean close-up of the QR code. A decoded HTTPS fiscal URL is fetched with SSRF protection, bounded timeout/size/redirect limits, and no JavaScript execution. If the fiscal portal exposes a same-host **Review invoice** form, the worker follows that one bounded form action and parses the resulting digital invoice, which is important for ZIMRA validation pages whose product lines appear only on the review page.

When the URL resolves to a configured authoritative host and the returned page contains the platform's verification marker plus receipt facts, the evidence is recorded as `zimra_verified`. This is the highest-precedence receipt evidence: verified digital receipt fields replace conflicting OCR fields, rather than merely filling blanks. The override is explicit in the stored evidence and warnings. The response is still parsed using the existing receipt parser; it does not bypass campaign dates, participating-outlet rules, product qualification, duplicate prevention, caps, or reviewer controls. Non-ZIMRA QR sources remain ordinary digital fallback evidence and do not override conflicting OCR.

## Reviewer interpretation

Open a submission and inspect **Digital receipt evidence**. The status values mean:

| Status | Meaning | Reviewer action |
|---|---|---|
| `not_attempted` | OCR was sufficient or the feature was disabled | Review the normal extraction evidence |
| `no_code` | No supported code was decoded, or a code was not an HTTPS fiscal URL | Ask for a clearer full receipt or manual review |
| `blocked_url` | URL or resolved host failed HTTPS/SSRF/allowlist policy | Treat as unavailable external evidence; do not bypass the policy |
| `fetch_failed` | Timeout, non-2xx response, redirect limit, or other network failure | Reprocess after checking the fiscal host and worker health |
| `unsupported_content` | The destination returned a PDF, binary, login page, or unsupported format | Manual review or obtain an HTML/JSON digital copy |
| `parsed` | Digital evidence was parsed and merged | Confirm fields used and review any disagreement warnings |

The `authority` field distinguishes `zimra_verified`, `digital_fiscal`, and `none`. A QR-only image is valid input; it is not expected to look like a till receipt because the digital fiscal page is the receipt evidence.

The console displays only the source/final host and path, query-key names, content type, fields used, bounded warnings, and a short document-hash prefix. It does not display or persist the full QR URL or URL query values.

## Configuration and rollout

Set the following on both the API and external worker services so behavior is consistent:

```dotenv
QR_FALLBACK_ENABLED=true
QR_FETCH_TIMEOUT_MS=8000
QR_FETCH_MAX_BYTES=1000000
QR_FETCH_MAX_REDIRECTS=3
QR_ALLOWED_HOSTS=
QR_AUTHORITATIVE_HOSTS=fdms.zimra.co.zw
```

Use `QR_ALLOWED_HOSTS` after the approved fiscal platform host is known, for example `fiscal.example.zw`. `QR_AUTHORITATIVE_HOSTS` is narrower: only official hosts whose verification page has been validated by operations may appear there. Do not add broad internal domains, metadata endpoints, localhost, private IP ranges, or user-controlled proxy hosts. The application rejects private/reserved resolutions even when the allowlist is empty.

## Monitoring

Monitor the worker logs and staff Operations view for:

- worker queue oldest age and retry/dead-letter growth;
- extraction latency and external-fetch timeouts;
- QR statuses, authority values, and `qr_*_disagreement` or `qr_authoritative_*_override` warnings in submission facts;
- review growth caused by `date_unreadable`, `receipt_number_unreadable`, or `extraction_consistency`;
- repeated `blocked_url` or `unsupported_content` statuses for one fiscal host.

Do not log decoded URL values, receipt query strings, fetched receipt bodies, or full digital OCR text outside the existing protected submission evidence path.

## Troubleshooting

If QR fallback is slow or increases backlog, set `QR_FALLBACK_ENABLED=false`, redeploy the API and worker, and allow existing queue items to drain. If one fiscal host fails, first confirm its public DNS, certificate, content type, redirects, and whether it requires a browser session. Add only the approved public hostname to `QR_ALLOWED_HOSTS`; never weaken SSRF checks.

If a digital receipt disagrees with OCR, the disagreement warning intentionally routes the item toward review instead of silently selecting one source. A reviewer can correct readable facts using the existing audited correction action and then qualify with a required note where identity is incomplete. If a fiscal portal has a summary page plus a review form, inspect the final `parsed` evidence path and the extracted fields; a `parsed` status with no line items means the portal did not expose product details on the first page or the review follow-up failed.

If the fallback is enabled but no evidence appears, verify that both API and worker are on the same release and that the worker is processing the queue. Existing submissions are not retroactively changed automatically; use the existing audited **Reprocess** action for a specific submission after confirming the reason.

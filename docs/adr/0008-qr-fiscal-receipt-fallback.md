# ADR 0008: QR-enabled fiscal-receipt fallback

- **Status:** accepted and extended for authoritative ZIMRA evidence
- **Date:** 2026-09-19
- **Decision owners:** Engineering and campaign operations

## Context

Some fiscal receipts contain a QR code whose destination presents a clearer digital copy of the receipt. OCR can fail on the same receipt because of blur, folds, ink marks, glare, perspective, or a small printed typeface. Treating the OCR result as the only source would turn recoverable purchases into false rejections.

The fallback must not make an arbitrary network request, silently replace conflicting evidence, or store receipt URLs and query tokens in logs. It also must not bypass the existing deterministic campaign rules or duplicate controls.

## Decision

After the configured extractor completes, the receipt pipeline performs a bounded QR/barcode fallback only when OCR is incomplete or low-confidence. The decoder uses ZXing for QR and common retail barcode formats, with jsQR as a complementary QR decoder across bounded crop and normalization variants. If a decoded value is an HTTPS URL, the fetcher:

1. Rejects credentials, non-HTTPS schemes, non-standard ports, configured-host violations, private/reserved IP addresses, and IPv4-mapped private IPv6 addresses.
2. Resolves each hop and connects to the resolved public address while preserving the original TLS server name and Host header.
3. Applies a timeout, response-byte cap, and redirect cap. Redirects are revalidated at every hop.
4. Parses only JSON, HTML, and text responses. PDFs, scripts requiring a browser, authentication challenges, and unsupported formats remain reviewable failures rather than being executed or guessed.

The fetched document is parsed through the same deterministic receipt parser. A participant may send a complete receipt image or a QR-only close-up. If the final verified page is on a configured authoritative host (`fdms.zimra.co.zw` by default), contains the platform verification marker, and exposes receipt facts, it is recorded as `zimra_verified`. Verified ZIMRA fields have higher precedence than OCR: conflicting identity, date, total, merchant, and product-line facts are replaced and an explicit `qr_authoritative_*_override` warning is recorded. Non-authoritative digital sources remain conservative: they fill empty OCR fields but do not replace conflicting OCR. In either case, digital line items are used when they contain products and are authoritative, or when OCR has no usable product lines.

Each extraction stores structured QR provenance rather than the full decoded URL: decoder version, barcode format, hashes of the code and fetched document, source/final host and path, query parameter names only, content type, fields used, timestamp, status, and bounded warnings. The full URL and fetched body are never written to application logs or persistent facts.

A successful QR fallback can satisfy the OCR-confidence gate because the evidence source has changed. Verified ZIMRA evidence can also turn a QR-only image whose OCR looks like a non-receipt into a receipt document. It cannot override campaign dates, participating-outlet rules, product qualification, duplicate prevention, caps, or manual-review controls.

## Configuration

- `QR_FALLBACK_ENABLED=true` enables the fallback. Set to `false` for an immediate feature rollback without changing extraction or campaign data.
- `QR_FETCH_TIMEOUT_MS` defaults to 8 seconds per request hop.
- `QR_FETCH_MAX_BYTES` defaults to 1,000,000 bytes.
- `QR_FETCH_MAX_REDIRECTS` defaults to 3.
- `QR_ALLOWED_HOSTS` is an optional comma-separated allowlist. An empty value still requires public HTTPS and SSRF checks; an allowlist is recommended once the fiscal platform’s stable hostnames are known.
- `QR_AUTHORITATIVE_HOSTS` defaults to `fdms.zimra.co.zw` and is narrower than the fetch allowlist. Only verified official fiscal hosts belong here.

The fallback runs in the existing external worker, so it is subject to the same queue lease, retry, and review monitoring as OCR.

## Consequences

The expected result is fewer false negatives for receipts with a usable digital fiscal representation and better reviewer evidence when the QR endpoint is unavailable. Processing latency and outbound network dependency increase only for receipts that need fallback. A fiscal site may be slow, unavailable, JavaScript-only, or protected by access controls; those cases remain safe and reviewable.

The QR path does not make the system an AI verifier. AI extraction, where configured, remains a separate extractor/provider choice and is still subject to the deterministic rules and reviewer controls.

## Rollout and rollback

1. Deploy the code with `QR_FALLBACK_ENABLED=false` in a non-production environment and run decoder, URL-policy, parser-merge, and fixture tests.
2. Enable the fallback for a bounded production observation window. Inspect QR status counts, fetch latency, worker queue age, review rate, and disagreement warnings.
3. Add known fiscal platform hosts to `QR_ALLOWED_HOSTS` after confirming their public DNS and HTTPS behavior.
4. Disable the feature if external fetch latency threatens queue SLOs, if a fiscal host changes format, or if disagreement/review rates increase unexpectedly. Existing extraction records remain auditable and can be reprocessed after correction.

Rollback is configuration-only: set `QR_FALLBACK_ENABLED=false` and redeploy the API/worker services. No database rollback is required.

# WhatsApp (Meta Cloud API)

Configuration: `WHATSAPP_PROVIDER=cloud-api`, `META_PHONE_NUMBER_ID`, `META_WABA_ID`, `META_ACCESS_TOKEN` (system user), `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION` (default v21.0), `DEFAULT_COUNTRY_CODE`.

Webhook: `GET /webhooks/whatsapp` answers the verification handshake (constant-time token compare); `POST /webhooks/whatsapp` validates `X-Hub-Signature-256` over the raw body, normalises messages (text, image, document, interactive, button, unsupported) and statuses (sent/delivered/read/failed), persists them and returns 200; a persistence failure returns 503 so Meta retries.

Media: resolved through the Graph API and downloaded only from Meta hosts; inline media is used by the simulator.

Sending: text, template and interactive payloads; a `SendError` carries a code, `permanent` and `unknownOutcome` flags used by the outbox (retry with backoff, permanent failure, or unknown outcome that is never re-sent automatically). Outside the 24-hour service window free-text winner contact is refused unless `content.winnerTemplateName` names an approved template.

Non-production: `OUTBOUND_ALLOWLIST` restricts recipients to designated test numbers; the simulator transport is refused in production and labelled "TEST ONLY" everywhere.

Not verified in this repository: no credentials were available, so the transport has not been exercised against Meta. First live step: `npm run smoke` after pointing the webhook at the deployment, then the phone track of the UAT script.

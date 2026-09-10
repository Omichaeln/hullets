# ADR-0001 — WhatsApp via the Meta Cloud API, behind a transport interface

**Status**: accepted · **Decision**: D-19-adjacent (channel), no client decision needed

## Context
The promotion runs on WhatsApp. Options: Meta's Cloud API directly, a BSP such as Twilio/360dialog, or an on-premise API (deprecated by Meta).

## Decision
Integrate the Cloud API directly (`packages/core/src/whatsapp/cloud-api.ts`) behind a small `WhatsAppTransport` interface (handshake, signature validation, event normalisation, media download, send, health). A `SimulatorTransport` implements the same interface for local and automated testing and is labelled TEST ONLY everywhere it appears.

## Consequences
- No BSP margin or extra hop; template management and the 24-hour service window are handled explicitly (dispatch refuses free-text winner contact outside the window unless a template is configured).
- Webhooks are verified with `X-Hub-Signature-256` before anything is persisted; media is fetched only from Meta hosts.
- Swapping to a BSP is a new transport class; the queue, conversation engine and outbox do not change.
- The transport is not exercised against Meta in this repository (no credentials); readiness stays "locally testable" until a test number and app secret are configured and the smoke run passes.

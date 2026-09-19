# ADR 0009: AI verification as a conservative advisory layer

- **Status:** implemented with OpenAI provider support; production enablement is an explicit configuration change
- **Date:** 2026-09-19
- **Decision owners:** Engineering, campaign operations, and fraud/risk owner

## Context

The receipt pipeline already preserves the original image, OCR text, normalized facts, deterministic rule results, duplicate signals, and reviewer decisions. An AI verifier can reduce avoidable manual work by assessing document authenticity indicators, OCR consistency, merchant consistency, anomalies, and contradictory evidence. It must not replace deterministic calculations, campaign rules, canonical duplicate controls, or the human approval boundary.

A model self-reported confidence is not a calibrated probability. Production automation requires labelled human outcomes before using a probability threshold for automatic decisions.

## Decision

Add a separate `AiVerificationService` after OCR, QR enrichment, deterministic evaluation, and duplicate-signal collection. The selected provider is **OpenAI** through the Chat Completions vision API; Anthropic remains available as an alternative. The service receives the original receipt image plus bounded structured facts, deterministic rule results, campaign-rule summary, QR provenance, and exact/visual duplicate counts. It uses strict structured JSON output and records:

- provider, model, prompt version, and latency;
- dimensions with `pass`, `fail`, `warning`, or `not_checkable` outcomes and bounded evidence;
- supporting and contradictory evidence;
- anomalies;
- an uncalibrated model signal, an explicitly null calibrated probability until a labelled calibration set exists, risk classification, and a bounded risk score;
- an advisory or hold decision.

The verifier is **disabled by default**. When enabled, a complete assessment with high risk, contradictions, or a model signal below the configured threshold holds an otherwise automatically qualified submission for human review. It never promotes a deterministic failure or unknown into a qualification. When the provider is unavailable, the submission proceeds under the configured availability policy unless `AI_VERIFICATION_REQUIRED=true`; required mode routes the item to review and fails readiness if the verifier is not configured.

Human review sees the original receipt, OCR/normalized facts, deterministic rules, QR evidence, and the AI assessment in separate cards. Human decisions remain the final qualification authority and become feedback records through the existing audit/review path. No automatic model retraining occurs from individual decisions.

## Configuration

- `AI_VERIFICATION_PROVIDER=openai` selects OpenAI; `AI_VERIFICATION_PROVIDER=anthropic` is retained as an alternative.
- `OPENAI_API_KEY` supplies the OpenAI credential; `OPENAI_BASE_URL` can target an OpenAI-compatible endpoint.
- `AI_VERIFICATION_ENABLED=false` keeps the service disabled.
- `AI_VERIFICATION_REQUIRED=false` avoids making the external model a hard availability dependency during the calibration phase.
- `AI_VERIFICATION_MODEL` selects the vision model and defaults to `gpt-4o-mini` for OpenAI.
- `AI_VERIFICATION_TIMEOUT_MS` bounds the request.
- `AI_VERIFICATION_MIN_PROBABILITY` is a conservative uncalibrated-signal hold threshold only; it must not be presented as a probability until calibrated.

## Calibration and progressive automation

Before enabling required mode or allowing AI to qualify any receipt, operations must create a labelled dataset of human-reviewed submissions covering clear receipts, unreadable receipts, QR-backed receipts, duplicate attempts, date failures, merchant mismatches, and likely fraud. Measure precision, recall, false qualification, false rejection, human override rate, review rate, latency, and cost per verified entry. Calibrated probability and decision thresholds should be versioned and approved separately from the model prompt.

The implementation therefore starts in three stages:

1. **Shadow/advisory:** collect assessments and reviewer comparisons with `AI_VERIFICATION_ENABLED=true`, `AI_VERIFICATION_REQUIRED=false`; no AI result changes a deterministic decision except a completed high-risk/contradictory assessment can hold a would-be qualification.
2. **Calibrated exception automation:** after labelled evaluation, configure approved thresholds and retain the conservative hold path.
3. **High-scale exception management:** only after sustained precision and override evidence, consider broader automation. Humans remain responsible for mandatory or high-risk exceptions.

## Consequences

The service increases processing latency and external-provider cost when enabled and can create review holds during provider incidents. Its strict schema, bounded prompt inputs, evidence storage, and explicit null calibration state make those costs visible and reversible. Disabling the feature or setting `AI_VERIFICATION_REQUIRED=false` is configuration-only; no schema rollback is needed.

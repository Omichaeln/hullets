import { afterEach, describe, expect, it, vi } from "vitest";
import { AiVerificationService } from "@promo/core/verification/service.ts";
import { emptyFacts } from "@promo/core/extraction/types.ts";
import type { Evaluation } from "@promo/core/eligibility/rules.ts";
import type { Rules } from "@promo/core/campaign/types.ts";

const input = {
  original: Buffer.from("receipt"), mime: "image/jpeg", facts: emptyFacts("test", "test"),
  evaluation: { disposition: "review", reason: "date_unreadable", rules: [], primaryPacks: 0, totalGrams: 0, matched: [], units: 0 } as Evaluation,
  rules: {} as Rules, duplicateSignals: { exact: 0, visual: 0 },
};

describe("AI verification safety modes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not call a provider when disabled", async () => {
    const service = new AiVerificationService({ provider: "openai", enabled: false, required: false, apiKey: "", model: "test", timeoutMs: 1000, minProbability: 0.98, maxRisk: "low" });
    const result = await service.verify(input);
    expect(result.status).toBe("not_attempted");
    expect(result.decision).toBe("not_applicable");
    expect(result.calibratedProbability).toBeNull();
  });

  it("holds when enabled but the provider is not configured", async () => {
    const service = new AiVerificationService({ provider: "openai", enabled: true, required: true, apiKey: "", model: "test", timeoutMs: 1000, minProbability: 0.98, maxRisk: "low" });
    const result = await service.verify(input);
    expect(result.status).toBe("not_configured");
    expect(result.decision).toBe("hold");
    expect(result.contradictoryEvidence).toContain("verification_provider_not_configured");
  });

  it("parses OpenAI structured vision output and never treats it as a final campaign decision", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ model: "gpt-test", choices: [{ message: { content: JSON.stringify({ model_probability: 0.99, risk: "low", dimensions: [{ name: "receipt_authenticity", outcome: "pass", evidence: ["visible fiscal layout"] }], supporting_evidence: ["merchant and line layout are consistent"], contradictory_evidence: [], anomalies: [] }) } }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const service = new AiVerificationService({ provider: "openai", enabled: true, required: false, apiKey: "redacted-test-key", model: "gpt-test", timeoutMs: 1000, minProbability: 0.98, maxRisk: "low" });
    const result = await service.verify(input);
    expect(result.status).toBe("complete");
    expect(result.provider).toBe("openai-verifier");
    expect(result.decision).toBe("advisory");
    expect(result.calibratedProbability).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/chat/completions"), expect.objectContaining({ method: "POST" }));
  });
});

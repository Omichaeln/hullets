import { describe, expect, it } from "vitest";
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
  it("does not call a provider when disabled", async () => {
    const service = new AiVerificationService({ enabled: false, required: false, apiKey: "", model: "test", timeoutMs: 1000, minProbability: 0.98, maxRisk: "low" });
    const result = await service.verify(input);
    expect(result.status).toBe("not_attempted");
    expect(result.decision).toBe("not_applicable");
    expect(result.calibratedProbability).toBeNull();
  });

  it("holds when enabled but the provider is not configured", async () => {
    const service = new AiVerificationService({ enabled: true, required: true, apiKey: "", model: "test", timeoutMs: 1000, minProbability: 0.98, maxRisk: "low" });
    const result = await service.verify(input);
    expect(result.status).toBe("not_configured");
    expect(result.decision).toBe("hold");
    expect(result.contradictoryEvidence).toContain("verification_provider_not_configured");
  });
});

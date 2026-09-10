import { z } from "zod";

/** Versioned, typed campaign rules. All thresholds explicit; integer grams. */
export const Product = z.object({ code: z.string().min(1), name: z.string().min(1), aliases: z.array(z.string()).default([]), packGrams: z.number().int().positive(), qualifying: z.boolean().default(true) });
export const Rules = z.object({
  version: z.literal(1).default(1),
  purchaseWindow: z.object({ start: z.string(), end: z.string() }).nullable().default(null),
  dateOrder: z.enum(["DMY", "MDY"]).default("DMY"),
  products: z.array(Product).default([]),
  qualification: z.object({ mode: z.enum(["packs", "weight"]).default("packs"), minPacks: z.number().int().positive().default(2), packGrams: z.number().int().positive().default(2000), minTotalGrams: z.number().int().positive().default(4000), allowMixedPacks: z.boolean().default(false) }).prefault({}),
  award: z.object({ unitsPerReceipt: z.number().int().positive().default(1) }).prefault({}),
  caps: z.object({ perParticipantPerPeriod: z.number().int().positive().nullable().default(null), perParticipantCampaign: z.number().int().positive().nullable().default(null) }).prefault({}),
  outletMatch: z.object({ required: z.boolean().default(true), minScore: z.number().min(0).max(1).default(0.5) }).prefault({}),
  review: z.object({ minDocumentScore: z.number().min(0).max(1).default(0.5), minOcrConfidence: z.number().min(0).max(1).default(0.3) }).prefault({}),
  eligibility: z.object({ minAge: z.number().int().default(18), priorWinnerExclusion: z.enum(["none", "campaign"]).default("none") }).prefault({}),
});
export type Rules = z.infer<typeof Rules>;
export const Flags = z.object({ participantStatus: z.boolean().default(true), identityStage: z.enum(["registration", "winner", "off"]).default("registration"), locationMode: z.enum(["town", "province", "outlet"]).default("town") });
export type Flags = z.infer<typeof Flags>;
export const Content = z.object({ termsVersion: z.string().default(""), privacyVersion: z.string().default(""), termsUrl: z.string().default(""), prizesText: z.string().default(""), prizeArtworkUrl: z.string().default(""), prizeArtworkAlt: z.string().default(""), winnerTemplateName: z.string().default(""), messages: z.record(z.string(), z.string()).default({}) });
export type Content = z.infer<typeof Content>;
export const PrizePlan = z.object({ tiers: z.array(z.object({ code: z.string().min(1), label: z.string().min(1), count: z.number().int().positive() })).default([]), alternatesPerWinner: z.number().int().min(0).default(1), onePrizePerParticipant: z.boolean().default(true), claimDays: z.number().int().positive().default(7) });
export type PrizePlan = z.infer<typeof PrizePlan>;

export const CAMPAIGN_TRANSITIONS: Record<string, string[]> = { draft: ["active"], active: ["paused", "closed"], paused: ["active", "closed"], closed: ["archived"], archived: [] };
export const DECISION_IDS = Array.from({ length: 22 }, (_, i) => `D-${String(i + 1).padStart(2, "0")}`);

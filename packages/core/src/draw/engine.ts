/**
 * Pure draw mathematics, shared by the service and the standalone verifier
 * (tools/verify-draw.ts re-implements it independently on purpose).
 *
 * Selection: every candidate entry receives `units` chances. For each chance
 * a 256-bit HMAC-SHA256 keyed by the committed seed over the chance label
 * gives a uniformly distributed score; sorting by score is an unbiased random
 * permutation (no modulo reduction). Winners are taken in order; with
 * onePrizePerParticipant a participant who already holds a prize is skipped
 * and their remaining chances are simply passed over. Alternates follow.
 */
import crypto from "node:crypto";
import { hashOf } from "../util/json.ts";
export const ALGORITHM = "hmac-sha256-sortition/1";
export const VERIFIER_VERSION = "draw-bundle/1";
export type Candidate = { entryId: string; participantId: string; units: number };
export type Plan = { tiers: Array<{ code: string; label: string; count: number }>; totalWinners: number; totalAlternates: number; onePrizePerParticipant: boolean };
export type Selection = { position: number; entryId: string; participantId: string; prizeCode: string | null };

export function sortition(candidates: Candidate[], seedHex: string) {
  const key = Buffer.from(seedHex, "hex"); const scored: Array<{ entryId: string; participantId: string; score: string }> = [];
  for (const c of candidates) for (let u = 0; u < Math.max(1, c.units); u++) scored.push({ entryId: c.entryId, participantId: c.participantId, score: crypto.createHmac("sha256", key).update(`chance:${c.entryId}:${u}`).digest("hex") });
  return scored.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : a.entryId < b.entryId ? -1 : 1));
}
export function prizeFor(rank: number, plan: Plan) { let c = 0; for (const t of plan.tiers) { c += t.count; if (rank <= c) return t.code; } return plan.tiers.at(-1)?.code ?? null; }
export function select(ordered: ReturnType<typeof sortition>, plan: Plan) {
  const winners: Selection[] = [], alternates: Selection[] = []; const seenE = new Set<string>(), seenP = new Set<string>();
  for (const s of ordered) {
    if (seenE.has(s.entryId)) continue; if (plan.onePrizePerParticipant && seenP.has(s.participantId)) continue;
    seenE.add(s.entryId); seenP.add(s.participantId);
    if (winners.length < plan.totalWinners) winners.push({ position: winners.length + 1, entryId: s.entryId, participantId: s.participantId, prizeCode: prizeFor(winners.length + 1, plan) });
    else if (alternates.length < plan.totalAlternates) alternates.push({ position: alternates.length + 1, entryId: s.entryId, participantId: s.participantId, prizeCode: null });
    else break;
  }
  return { winners, alternates };
}
export function planFrom(p: { tiers: Array<{ code: string; label: string; count: number }>; alternatesPerWinner: number; onePrizePerParticipant: boolean }): Plan { const totalWinners = p.tiers.reduce((a, t) => a + t.count, 0); return { tiers: p.tiers, totalWinners, totalAlternates: totalWinners * p.alternatesPerWinner, onePrizePerParticipant: p.onePrizePerParticipant }; }
export function computeOutput(snapshot: { candidates: Candidate[]; plan: Plan }, seedHex: string) { const ordered = sortition(snapshot.candidates, seedHex); const { winners, alternates } = select(ordered, snapshot.plan); return { algorithm: ALGORITHM, sequence: ordered.map((s) => s.entryId), winners, alternates }; }
export const seedCommitment = (seedHex: string) => crypto.createHash("sha256").update(`seed:${seedHex}`).digest("hex");
export { hashOf };

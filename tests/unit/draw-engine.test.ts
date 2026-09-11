import { describe, it, expect } from "vitest";
import { sortition, select, planFrom, computeOutput, seedCommitment } from "../../packages/core/src/draw/engine.ts";
import { hashOf } from "../../packages/core/src/util/json.ts";
import { sha256 } from "../../packages/core/src/util/crypto.ts";
import { verifyBundle } from "../../tools/verify-draw.ts";
describe("draw engine", () => {
  const cands = Array.from({ length: 60 }, (_, i) => ({ entryId: `e${i}`, participantId: `p${i % 20}`, units: 1 }));
  const seed = "ab".repeat(32);
  it("is deterministic for a seed and differs across seeds", () => { expect(sortition(cands, seed).map((s) => s.entryId)).toEqual(sortition(cands, seed).map((s) => s.entryId)); expect(sortition(cands, seed).slice(0, 5).map((s) => s.entryId)).not.toEqual(sortition(cands, "cd".repeat(32)).slice(0, 5).map((s) => s.entryId)); });
  it("gives every entry an equal chance (uniform first position over many seeds)", () => { const counts = new Map<string, number>(); const N = 3000; for (let i = 0; i < N; i++) { const s = sortition(cands.slice(0, 6), i.toString(16).padStart(64, "0")); counts.set(s[0].entryId, (counts.get(s[0].entryId) ?? 0) + 1); } for (const v of counts.values()) expect(Math.abs(v - N / 6)).toBeLessThan(N / 6 * 0.35); expect(counts.size).toBe(6); });
  it("units multiply chances; one prize per participant enforced after each selection; alternates follow", () => {
    expect(sortition([{ entryId: "x", participantId: "p", units: 3 }], seed).length).toBe(3);
    const plan = planFrom({ tiers: [{ code: "P1", label: "A", count: 2 }, { code: "P2", label: "B", count: 3 }], alternatesPerWinner: 2, onePrizePerParticipant: true });
    const sel = select(sortition(cands, seed), plan); expect(sel.winners.length).toBe(5); expect(new Set(sel.winners.map((w) => w.participantId)).size).toBe(5); expect(sel.alternates.length).toBe(10); expect(sel.winners.map((w) => w.prizeCode)).toEqual(["P1", "P1", "P2", "P2", "P2"]);
    const multi = select(sortition(cands, seed), { ...plan, onePrizePerParticipant: false }); expect(multi.winners.length).toBe(5);
  });
  it("the standalone verifier accepts a consistent bundle and rejects tampering", () => {
    const plan = planFrom({ tiers: [{ code: "P1", label: "A", count: 2 }], alternatesPerWinner: 1, onePrizePerParticipant: true });
    const snap = { drawId: "d1", campaignId: "c", periodCode: "W1", rulesVersionHash: "h", plan, candidates: cands.slice(0, 10), exclusions: [], seedCommitment: seedCommitment(seed) };
    const out = computeOutput(snap, seed);
    let prev = ""; const auditEvents = ["draw.frozen", "draw.executed", "draw.approved"].map((action) => { const body = `{"action":"${action}"}`; const entryHash = sha256(prev + body); const e = { action, body, prevHash: prev, entryHash }; prev = entryHash; return e; });
    const bundle = { bundleVersion: "draw-bundle/1", draw: { id: "d1", periodCode: "W1", status: "approved", algorithm: out.algorithm, snapshotHash: hashOf(snap), seedCommitment: snap.seedCommitment, outputHash: hashOf(out), officerId: "o", executedBy: "o", approverId: "a", executedAt: "2026-01-01T00:00:00Z", approvedAt: "2026-01-01T00:01:00Z" }, snapshot: snap, seedHex: seed, output: out, auditEvents, auditCheckpoint: null };
    expect(verifyBundle(bundle).verified).toBe(true);
    for (const mutate of [(b: typeof bundle) => { b.output.winners[0].entryId = b.output.alternates[0].entryId; }, (b: typeof bundle) => { b.seedHex = "00".repeat(32); }, (b: typeof bundle) => { b.snapshot.candidates.pop(); }, (b: typeof bundle) => { b.draw.approverId = "o"; }, (b: typeof bundle) => { b.auditEvents[1].body += " "; }]) { const t = JSON.parse(JSON.stringify(bundle)) as typeof bundle; mutate(t); expect(verifyBundle(t).verified).toBe(false); }
  });
});

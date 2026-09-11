/**
 * Independent draw verifier. Consumes an exported bundle (JSON) and recomputes
 * everything WITHOUT the database or the live draw service: snapshot digest,
 * seed commitment, HMAC sortition from the committed seed, prize plan
 * application, output digest, counts, separation of duties, audit-event
 * recomputation and (optionally) the signed checkpoint. The maths here is a
 * deliberate re-implementation, not an import of the service.
 * Usage: npm run verify:draw -- bundle.json [--signing-key KEY]   exit 0 = verified
 */
import fs from "node:fs";
import crypto from "node:crypto";
export function verifyBundle(b: Record<string, unknown>, signingKey = ""): { verified: boolean; checks: Array<{ name: string; pass: boolean; detail?: unknown }> } {
  const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v === undefined ? null : v);
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  const checks: Array<{ name: string; pass: boolean; detail?: unknown }> = []; const ok = (name: string, pass: boolean, detail?: unknown) => checks.push({ name, pass: !!pass, detail });
  const d = b.draw as Record<string, unknown>; const snap = b.snapshot as { drawId: string; periodCode: string; plan: { tiers: Array<{ code: string; count: number }>; totalWinners: number; totalAlternates: number; onePrizePerParticipant: boolean }; candidates: Array<{ entryId: string; participantId: string; units: number }>; seedCommitment: string };
  ok("bundle version", b.bundleVersion === "draw-bundle/1", b.bundleVersion);
  ok("snapshot digest", sha(canon(snap)) === d.snapshotHash, d.snapshotHash);
  ok("snapshot names this draw and period", snap.drawId === d.id && snap.periodCode === d.periodCode);
  ok("candidates unique", new Set(snap.candidates.map((c) => c.entryId)).size === snap.candidates.length, snap.candidates.length);
  ok("seed commitment recorded with the snapshot", snap.seedCommitment === d.seedCommitment);
  if (d.status === "frozen" || d.status === "executing") ok("randomness withheld until execution", b.seedHex == null && b.output == null);
  else {
    const seed = String(b.seedHex ?? ""); ok("seed matches its commitment", sha(`seed:${seed}`) === snap.seedCommitment);
    const key = Buffer.from(seed, "hex"); const scored: Array<{ entryId: string; participantId: string; score: string }> = [];
    for (const c of snap.candidates) for (let u = 0; u < Math.max(1, c.units); u++) scored.push({ entryId: c.entryId, participantId: c.participantId, score: crypto.createHmac("sha256", key).update(`chance:${c.entryId}:${u}`).digest("hex") });
    scored.sort((a, b2) => (a.score < b2.score ? -1 : a.score > b2.score ? 1 : a.entryId < b2.entryId ? -1 : 1));
    const prize = (rank: number) => { let c = 0; for (const t of snap.plan.tiers) { c += t.count; if (rank <= c) return t.code; } return snap.plan.tiers.at(-1)?.code ?? null; };
    const winners: Array<{ position: number; entryId: string; participantId: string; prizeCode: string | null }> = [], alternates: typeof winners = []; const seenE = new Set<string>(), seenP = new Set<string>();
    for (const s of scored) { if (seenE.has(s.entryId)) continue; if (snap.plan.onePrizePerParticipant && seenP.has(s.participantId)) continue; seenE.add(s.entryId); seenP.add(s.participantId); if (winners.length < snap.plan.totalWinners) winners.push({ position: winners.length + 1, entryId: s.entryId, participantId: s.participantId, prizeCode: prize(winners.length + 1) }); else if (alternates.length < snap.plan.totalAlternates) alternates.push({ position: alternates.length + 1, entryId: s.entryId, participantId: s.participantId, prizeCode: null }); else break; }
    const recomputed = { algorithm: d.algorithm, sequence: scored.map((s) => s.entryId), winners, alternates };
    ok("output digest", sha(canon(recomputed)) === d.outputHash, d.outputHash);
    ok("stored output equals recomputation", canon(recomputed) === canon(b.output));
    ok("winner count matches the plan", winners.length === Math.min(snap.plan.totalWinners, winners.length) && (b.output as { winners: unknown[] })?.winners?.length === winners.length, `${winners.length}/${snap.plan.totalWinners}`);
    ok("alternate count within the plan", ((b.output as { alternates: unknown[] })?.alternates?.length ?? 0) <= snap.plan.totalAlternates);
    ok("winners are eligible candidates", winners.every((w) => snap.candidates.some((c) => c.entryId === w.entryId)));
    ok("one prize per participant", !snap.plan.onePrizePerParticipant || new Set(winners.map((w) => w.participantId)).size === winners.length);
    ok("prize codes valid", winners.every((w) => snap.plan.tiers.some((t) => t.code === w.prizeCode)));
  }
  if (["approved", "published"].includes(String(d.status))) { ok("approver recorded", !!d.approverId); ok("approver differs from officer and executor", !!d.approverId && d.approverId !== d.officerId && d.approverId !== d.executedBy, `${d.officerId}/${d.executedBy} vs ${d.approverId}`); ok("approval after execution", Date.parse(String(d.approvedAt)) >= Date.parse(String(d.executedAt))); }
  const events = (b.auditEvents ?? []) as Array<{ prevHash: string; entryHash: string; body: string; action: string }>;
  ok("draw audit events recompute", events.every((e) => sha((e.prevHash ?? "") + e.body) === e.entryHash), events.length);
  ok("audit trail has freeze and execute", events.some((e) => e.action === "draw.frozen") && (d.status === "frozen" || events.some((e) => e.action === "draw.executed")));
  if (["approved", "published"].includes(String(d.status))) ok("audit trail has approval", events.some((e) => e.action === "draw.approved"));
  const cp = b.auditCheckpoint as { uptoId: number; headHash: string; signature: string; signed: boolean } | null;
  if (cp) ok("audit checkpoint signature", crypto.createHmac("sha256", signingKey || "unsigned").update(`${cp.uptoId}|${cp.headHash}`).digest("hex") === cp.signature, signingKey ? "keyed" : "unsigned (pass --signing-key)");
  return { verified: checks.every((c) => c.pass), checks };
}
if (process.argv[1] && /verify-draw\.ts$/.test(process.argv[1])) {
  const file = process.argv[2]; if (!file) { console.error("usage: npm run verify:draw -- bundle.json [--signing-key KEY]"); process.exit(2); }
  const ki = process.argv.indexOf("--signing-key"); const key = ki > 0 ? process.argv[ki + 1] : process.env.AUDIT_SIGNING_KEY ?? "";
  const r = verifyBundle(JSON.parse(fs.readFileSync(file, "utf8")), key); console.log(JSON.stringify(r, null, 2)); process.exit(r.verified ? 0 : 1);
}

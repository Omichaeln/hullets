// Observability primitives: redaction of stored error messages, stable fingerprints, availability maths.
import { describe, it, expect } from "vitest";
import { redactMessage, fingerprintOf, sanitiseDetail, availability } from "@promo/core";

describe("error message redaction", () => {
  it("masks phone numbers, e-mail addresses, tokens and deep paths; keeps the shape of the message", () => {
    const m = redactMessage("send to +263 77 123 4567 failed for tendai@example.test with token abc.def.ghi at /home/app/packages/core/src/x.ts (status 503)");
    expect(m).not.toContain("263 77 123 4567"); expect(m).toContain("***4567"); expect(m).toContain("[email]"); expect(m).toContain("token [redacted]"); expect(m).toContain("[path]"); expect(m).toContain("status 503");
  });
  it("leaves short numbers (counts, statuses, ids) alone and bounds the length", () => {
    expect(redactMessage("timeout after 30000 ms on attempt 3")).toBe("timeout after 30000 ms on attempt 3");
    expect(redactMessage("x".repeat(2000)).length).toBe(500); expect(redactMessage(undefined)).toBe("error"); expect(redactMessage("")).toBe("error");
  });
  it("drops sensitive detail keys and redacts string values", () => {
    const d = sanitiseDetail({ status: 503, phone: "263771234567", identity: "63-123456A", note: "call 263771234567", nested: { a: 1 }, list: [1, 2] })!;
    expect(d.phone).toBeUndefined(); expect(d.identity).toBeUndefined(); expect(d.status).toBe(503); expect(d.note).toBe("call ***4567"); expect(d.nested).toBe("[object]"); expect(d.list).toBe("[array 2]");
  });
});

describe("fingerprints", () => {
  it("are stable across identifiers, numbers and hex, and distinct across source, code and path", () => {
    const a = fingerprintOf({ source: "worker.job", code: "JOB_FAILED", path: "submission.process", message: "submission sub_AbCdEf123456 not found after 3 attempts (req_0123456789abcdef)" });
    const b = fingerprintOf({ source: "worker.job", code: "JOB_FAILED", path: "submission.process", message: "submission sub_ZzYyXx987654 not found after 5 attempts (req_fedcba9876543210)" });
    expect(a).toBe(b); expect(a).toHaveLength(16);
    expect(fingerprintOf({ source: "trpc", code: "JOB_FAILED", path: "submission.process", message: "x" })).not.toBe(fingerprintOf({ source: "http", code: "JOB_FAILED", path: "submission.process", message: "x" }));
    expect(fingerprintOf({ source: "trpc", code: "A", path: "p", message: "x" })).not.toBe(fingerprintOf({ source: "trpc", code: "A", path: "q", message: "x" }));
  });
});

describe("availability from health samples", () => {
  const t0 = Date.parse("2026-09-11T00:00:00Z"); const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
  it("is 100% when samples arrive every minute and every check passes", () => {
    const a = availability(Array.from({ length: 60 }, (_, i) => ({ at: at(i), ok: true })), at(60));
    expect(a.availabilityPct).toBe(100); expect(a.gaps).toEqual([]); expect(a.observedFrom).toBe(at(0)); expect(a.samples).toBe(60);
  });
  it("counts a silence longer than the coverage allowance as not reporting, and an ongoing silence as ongoing", () => {
    const rows = [...Array.from({ length: 10 }, (_, i) => ({ at: at(i), ok: true })), ...Array.from({ length: 10 }, (_, i) => ({ at: at(40 + i), ok: true }))];
    const a = availability(rows, at(50)); // 9 minutes of samples, silent 9→40 (vouched 2.5 min), samples 40→49
    expect(a.gaps).toHaveLength(1); expect(a.gaps[0].kind).toBe("no_samples"); expect(a.gaps[0].from).toBe(at(11.5)); expect(a.gaps[0].to).toBe(at(40)); expect(a.gaps[0].ongoing).toBe(false);
    expect(a.downtimeSec).toBe(28.5 * 60); expect(a.availabilityPct).toBeCloseTo(100 * (1 - 28.5 / 50), 2);
    const b = availability(rows.slice(0, 10), at(60)); expect(b.gaps[0].ongoing).toBe(true); expect(b.gaps[0].from).toBe(at(11.5)); expect(b.downtimeSec).toBe(48.5 * 60);
  });
  it("counts failing checks as degraded time until the next healthy sample", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ at: at(i), ok: i < 10 || i >= 20 })); const a = availability(rows, at(30));
    expect(a.degradedSec).toBe(10 * 60); expect(a.downtimeSec).toBe(0); expect(a.gaps).toEqual([{ from: at(10), to: at(20), seconds: 600, kind: "degraded", ongoing: false }]); expect(a.availabilityPct).toBeCloseTo(100 * (1 - 10 / 30), 3);
  });
  it("starts observing at the first sample, so a freshly deployed service is not charged for the past", () => {
    const a = availability([{ at: at(1000), ok: true }, { at: at(1001), ok: true }], at(1002)); expect(a.availabilityPct).toBe(100); expect(a.observedSec).toBe(120);
    expect(availability([], at(5)).availabilityPct).toBeNull();
  });
});

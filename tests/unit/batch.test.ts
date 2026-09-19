import { describe, expect, it } from "vitest";
import { chunkForInsert, maxRowsPerInsert, PG_MAX_BIND_PARAMS } from "@promo/core/util/batch.ts";

describe("bulk insert sizing", () => {
  it("keeps every batch inside PostgreSQL's 16-bit bind-parameter limit", () => {
    for (const columns of [1, 2, 6, 7, 10, 40]) {
      const rows = Array.from({ length: 50_000 }, (_, i) => i);
      for (const batch of chunkForInsert(rows, columns)) {
        expect(batch.length * columns, `${columns} columns`).toBeLessThanOrEqual(PG_MAX_BIND_PARAMS);
      }
    }
  });

  it("covers every row exactly once, in order", () => {
    const rows = Array.from({ length: 4_501 }, (_, i) => i);
    const flat = chunkForInsert(rows, 6, 1_000).flat();
    expect(flat).toEqual(rows);
  });

  it("sizes from the column count", () => {
    // draw_candidates binds six parameters per row: 65535/6 = 10922, which is
    // exactly where a single statement used to break.
    expect(maxRowsPerInsert(6, 1_000_000)).toBe(10_922);
    expect(maxRowsPerInsert(6)).toBe(2_000); // the default cap bites first
  });

  it("refuses a nonsensical column count rather than producing an unsafe batch", () => {
    expect(() => maxRowsPerInsert(0)).toThrow();
    expect(() => maxRowsPerInsert(-1)).toThrow();
  });

  it("handles an empty input", () => { expect(chunkForInsert([], 6)).toEqual([]); });
});

/**
 * Bulk insert sizing.
 *
 * PostgreSQL's wire protocol carries the parameter count of a Bind message in a
 * 16-bit field, so a single statement can bind at most 65,535 values. A
 * multi-row INSERT binds one parameter per column per row, so the row ceiling is
 * 65535 / columns. Exceeding it does not produce a useful error: the count wraps
 * and the server answers "bind message has 2 parameter formats but 0
 * parameters", which names neither the statement nor the limit.
 *
 * `chunkForInsert` sizes batches from the column count with headroom, so callers
 * never have to know the arithmetic. Use it for any insert whose row count is
 * driven by data volume rather than by a fixed small structure.
 */
export const PG_MAX_BIND_PARAMS = 65_535;

/** Largest safe row count for a statement binding `columns` parameters per row. */
export function maxRowsPerInsert(columns: number, cap = 2_000): number {
  if (!Number.isInteger(columns) || columns < 1) throw new Error("columns must be a positive integer");
  return Math.max(1, Math.min(cap, Math.floor(PG_MAX_BIND_PARAMS / columns)));
}

/** Split `rows` into batches that each bind at most PG_MAX_BIND_PARAMS parameters. */
export function chunkForInsert<T>(rows: readonly T[], columns: number, cap = 2_000): T[][] {
  const size = maxRowsPerInsert(columns, cap);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size) as T[]);
  return out;
}

/** Run `insert` once per batch, in order. Returns the number of rows written. */
export async function insertInChunks<T>(rows: readonly T[], columns: number, insert: (batch: T[]) => Promise<unknown>, cap = 2_000): Promise<number> {
  for (const batch of chunkForInsert(rows, columns, cap)) await insert(batch);
  return rows.length;
}

export const nowIso = () => new Date().toISOString();
export const addMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
export const minutes = (n: number) => n * 60_000;
export const hours = (n: number) => n * 3_600_000;
export const days = (n: number) => n * 86_400_000;
/** Exponential backoff with full jitter, capped. */
export const backoffMs = (attempt: number, baseMs = 2000, capMs = 300_000) => Math.floor(Math.random() * Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1)));

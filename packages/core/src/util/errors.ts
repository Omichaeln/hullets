/** Domain errors carry a stable machine code; the transport layer maps codes to HTTP/tRPC statuses. */
export type ErrorCode = "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "FORBIDDEN" | "UNAUTHORIZED" | "SOD" | "BLOCKED" | "INTEGRITY" | "APPROVAL_REQUIRED" | "IDENTITY_INCOMPLETE" | "RATE_LIMITED" | "UNAVAILABLE";
export class DomainError extends Error {
  constructor(public code: ErrorCode, message: string, public extra: Record<string, unknown> = {}) { super(message); this.name = "DomainError"; }
}
export const err = (code: ErrorCode, message: string, extra?: Record<string, unknown>) => new DomainError(code, message, extra);
export const notFound = (what = "resource") => err("NOT_FOUND", `${what} not found`);
export const conflict = (m: string, extra?: Record<string, unknown>) => err("CONFLICT", m, extra);
export const invalid = (m: string, extra?: Record<string, unknown>) => err("VALIDATION", m, extra);
export const forbidden = (m = "forbidden") => err("FORBIDDEN", m);

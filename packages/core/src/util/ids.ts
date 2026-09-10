import crypto from "node:crypto";
/** Prefixed, unguessable identifiers (96 random bits) — never sequential. */
export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
/** Participant-facing submission reference: short, unambiguous alphabet, unique per campaign by constraint. */
export function newReference(): string { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b = crypto.randomBytes(8); let s = ""; for (let i = 0; i < 8; i++) s += A[b[i] % A.length]; return `R-${s.slice(0, 4)}-${s.slice(4)}`; }

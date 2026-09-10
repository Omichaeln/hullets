import { initTRPC, TRPCError } from "@trpc/server";
import type { App, StaffUser, Permission } from "./deps.ts";
import { can, DomainError } from "./deps.ts";

export type Context = { app: App; user: StaffUser | null; bearer: string | null; correlationId: string; ip: string };
const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) { const cause = error.cause; const extra = cause instanceof DomainError ? cause.extra : {}; return { ...shape, data: { ...shape.data, domainCode: cause instanceof DomainError ? cause.code : undefined, ...extra } }; },
});
const CODE: Record<string, TRPCError["code"]> = { VALIDATION: "BAD_REQUEST", NOT_FOUND: "NOT_FOUND", CONFLICT: "CONFLICT", FORBIDDEN: "FORBIDDEN", UNAUTHORIZED: "UNAUTHORIZED", SOD: "FORBIDDEN", BLOCKED: "CONFLICT", INTEGRITY: "CONFLICT", APPROVAL_REQUIRED: "FORBIDDEN", IDENTITY_INCOMPLETE: "CONFLICT", RATE_LIMITED: "TOO_MANY_REQUESTS", UNAVAILABLE: "INTERNAL_SERVER_ERROR" };
/** Domain errors become typed tRPC errors; anything else is an opaque internal error (never a stack or SQL). */
const mapErrors = t.middleware(async ({ next }) => { try { return await next(); } catch (e) { if (e instanceof TRPCError) throw e; if (e instanceof DomainError) throw new TRPCError({ code: CODE[e.code] ?? "INTERNAL_SERVER_ERROR", message: e.message, cause: e }); throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "internal error", cause: e as Error }); } });
export const router = t.router; export const publicProcedure = t.procedure.use(mapErrors);
const authed = t.middleware(({ ctx, next }) => { if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "authentication required" }); return next({ ctx: { ...ctx, user: ctx.user } }); });
/** Any signed-in staff member, even before the temporary password is changed. */
export const sessionProcedure = t.procedure.use(mapErrors).use(authed);
/** Requires a permission; a temporary password blocks everything except the self-service procedures. */
export const guard = (permission?: Permission) => t.procedure.use(mapErrors).use(authed).use(({ ctx, next }) => {
  if (ctx.user!.mustChangePassword) throw new TRPCError({ code: "FORBIDDEN", message: "change your temporary password first", cause: new DomainError("FORBIDDEN", "PASSWORD_CHANGE_REQUIRED") });
  if (permission && !can(ctx.user!.roles, permission)) throw new TRPCError({ code: "FORBIDDEN", message: `requires permission ${permission}` });
  return next({ ctx: { ...ctx, user: ctx.user! } });
});
export type Meta = { permission?: Permission };

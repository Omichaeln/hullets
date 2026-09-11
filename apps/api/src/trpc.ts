import { initTRPC, TRPCError } from "@trpc/server";
import type { App, StaffUser, Permission } from "./deps.ts";
import { can, DomainError } from "./deps.ts";

export type Context = { app: App; user: StaffUser | null; bearer: string | null; correlationId: string; ip: string };
export type Meta = { permission?: Permission; session?: boolean; public?: boolean };
const t = initTRPC.context<Context>().meta<Meta>().create({
  /** Never a stack trace on the wire; domain errors expose their stable code and structured extras. */
  errorFormatter({ shape, error }) { const cause = error.cause; const extra = cause instanceof DomainError ? cause.extra : {}; const { stack: _stack, ...data } = shape.data as typeof shape.data & { stack?: string }; return { ...shape, data: { ...data, domainCode: cause instanceof DomainError ? cause.code : undefined, ...extra } }; },
});
const CODE: Record<string, TRPCError["code"]> = { VALIDATION: "BAD_REQUEST", NOT_FOUND: "NOT_FOUND", CONFLICT: "CONFLICT", FORBIDDEN: "FORBIDDEN", UNAUTHORIZED: "UNAUTHORIZED", SOD: "FORBIDDEN", BLOCKED: "CONFLICT", INTEGRITY: "CONFLICT", APPROVAL_REQUIRED: "FORBIDDEN", IDENTITY_INCOMPLETE: "CONFLICT", RATE_LIMITED: "TOO_MANY_REQUESTS", UNAVAILABLE: "INTERNAL_SERVER_ERROR" };
/** Domain errors become typed tRPC errors; anything else is an opaque internal error (never a stack or SQL). */
const mapErrors = t.middleware(async ({ ctx, next, path }) => {
  const r = await next();
  if (r.ok) return r;
  // tRPC wraps resolver throws in a TRPCError before middleware sees them; unwrap the domain cause.
  const e = r.error; const cause = e.cause;
  if (cause instanceof DomainError) {
    if (cause.code === "UNAVAILABLE") await ctx.app.observability.record({ source: "trpc", code: cause.code, message: cause.message, path, correlationId: ctx.correlationId, actorId: ctx.user?.id ?? null });
    throw new TRPCError({ code: CODE[cause.code] ?? "INTERNAL_SERVER_ERROR", message: cause.message, cause });
  }
  if (e.code === "INTERNAL_SERVER_ERROR") {
    // Recorded in the error log (redacted, fingerprinted) before the caller gets the opaque message.
    await ctx.app.observability.record({ source: "trpc", code: typeof (cause as { code?: unknown } | undefined)?.code === "string" ? String((cause as unknown as { code: string }).code) : "INTERNAL", message: (cause as Error | undefined)?.message ?? e.message, path, correlationId: ctx.correlationId, actorId: ctx.user?.id ?? null });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "internal error", cause });
  }
  throw e;
});
export const router = t.router; export const publicProcedure = t.procedure.meta({ public: true }).use(mapErrors);
const authed = t.middleware(({ ctx, next }) => { if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "authentication required" }); return next({ ctx: { ...ctx, user: ctx.user } }); });
/** Any signed-in staff member, even before the temporary password is changed. */
export const sessionProcedure = t.procedure.meta({ session: true }).use(mapErrors).use(authed);
/** Requires a permission; a temporary password blocks everything except the self-service procedures. */
export const guard = (permission?: Permission) => t.procedure.meta({ permission, session: true }).use(mapErrors).use(authed).use(({ ctx, next }) => {
  if (ctx.user!.mustChangePassword) throw new TRPCError({ code: "FORBIDDEN", message: "change your temporary password first", cause: new DomainError("FORBIDDEN", "PASSWORD_CHANGE_REQUIRED") });
  if (permission && !can(ctx.user!.roles, permission)) throw new TRPCError({ code: "FORBIDDEN", message: `requires permission ${permission}` });
  return next({ ctx: { ...ctx, user: ctx.user! } });
});

import { z } from "zod";
import { router, publicProcedure, sessionProcedure, guard } from "../trpc.ts";
import { TRPCError } from "@trpc/server";
/**
 * Both authentication steps are throttled in the database (see AuthThrottle).
 *
 * The account is always part of the key and the address is only ever an extra
 * dimension, because `ctx.ip` derives from X-Forwarded-For: it is trustworthy
 * exactly as far as the configured proxy depth, and an attacker who can vary it
 * must still exhaust the per-account budget. The MFA step is throttled too —
 * six digits with unlimited guesses is not a second factor.
 */
const accountKey = (email: string) => email.trim().toLowerCase();
export const authRouter = router({
  login: publicProcedure.input(z.object({ email: z.string().email(), password: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    const account = accountKey(input.email); const throttle = ctx.app.auth.throttle;
    for (const [kind, key] of [["login", account], ["login-ip", `${ctx.ip}|${account}`]] as const) {
      const d = await throttle.check(kind, key);
      if (d.limited) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `too many attempts; retry in ${d.retryAfterSeconds}s` });
    }
    const r = await ctx.app.auth.login({ email: input.email, password: input.password, ip: ctx.ip });
    if (!r) {
      await throttle.fail("login", account); await throttle.fail("login-ip", `${ctx.ip}|${account}`);
      throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid credentials" });
    }
    if ("pendingMfa" in r) return { pendingMfa: true as const, userId: r.userId, challengeId: r.challengeId };
    await throttle.clear("login", account); await throttle.clear("login-ip", `${ctx.ip}|${account}`);
    return { pendingMfa: false as const, token: r.token, user: r.user };
  }),
  verifyMfa: publicProcedure.input(z.object({ userId: z.string(), code: z.string().min(6).max(8), challengeId: z.string().optional() })).mutation(async ({ ctx, input }) => {
    const throttle = ctx.app.auth.throttle;
    const d = await throttle.check("mfa", input.userId);
    if (d.limited) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `too many codes tried; retry in ${d.retryAfterSeconds}s` });
    try {
      const r = await ctx.app.auth.verifyMfa({ userId: input.userId, code: input.code, challengeId: input.challengeId ?? null, ip: ctx.ip });
      await throttle.clear("mfa", input.userId);
      return { token: r.token, user: r.user };
    } catch (e) { await throttle.fail("mfa", input.userId); throw e; }
  }),
  logout: sessionProcedure.mutation(async ({ ctx }) => { if (ctx.bearer) await ctx.app.auth.revoke(ctx.bearer); return { ok: true }; }),
  me: sessionProcedure.query(({ ctx }) => ({ ...ctx.user, environment: ctx.app.environment })),
  changePassword: sessionProcedure.input(z.object({ currentPassword: z.string(), newPassword: z.string() })).mutation(async ({ ctx, input }) => { await ctx.app.auth.changePassword(ctx.user.id, input.currentPassword, input.newPassword); return { ok: true }; }),
  mfaEnroll: sessionProcedure.mutation(({ ctx }) => ctx.app.auth.enrollMfa(ctx.user.id)),
  mfaEnable: sessionProcedure.input(z.object({ code: z.string() })).mutation(async ({ ctx, input }) => { await ctx.app.auth.setMfa(ctx.user.id, input.code, true); return { ok: true }; }),
  mfaDisable: guard().input(z.object({ code: z.string() })).mutation(async ({ ctx, input }) => { await ctx.app.auth.setMfa(ctx.user.id, input.code, false); return { ok: true }; }),
  directory: guard().query(({ ctx }) => ctx.app.auth.directory()),
});

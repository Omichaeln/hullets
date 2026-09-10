import { z } from "zod";
import { router, publicProcedure, sessionProcedure, guard } from "../trpc.ts";
import { TRPCError } from "@trpc/server";
const attempts = new Map<string, number[]>(); const WINDOW = 60_000, MAX = 5;
function limited(ip: string) { const now = Date.now(); const arr = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW); if (arr.length >= MAX) { attempts.set(ip, arr); return Math.ceil((arr[0] + WINDOW - now) / 1000); } arr.push(now); attempts.set(ip, arr); return 0; }
export const authRouter = router({
  login: publicProcedure.input(z.object({ email: z.string().email(), password: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    const retry = limited(ctx.ip); if (retry) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `too many attempts; retry in ${retry}s` });
    const r = await ctx.app.auth.login({ email: input.email, password: input.password, ip: ctx.ip });
    if (!r) throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid credentials" });
    if ("pendingMfa" in r) return { pendingMfa: true as const, userId: r.userId };
    attempts.delete(ctx.ip); return { pendingMfa: false as const, token: r.token, user: r.user };
  }),
  verifyMfa: publicProcedure.input(z.object({ userId: z.string(), code: z.string().min(6).max(8) })).mutation(async ({ ctx, input }) => { const r = await ctx.app.auth.verifyMfa({ userId: input.userId, code: input.code, ip: ctx.ip }); return { token: r.token, user: r.user }; }),
  logout: sessionProcedure.mutation(async ({ ctx }) => { if (ctx.bearer) await ctx.app.auth.revoke(ctx.bearer); return { ok: true }; }),
  me: sessionProcedure.query(({ ctx }) => ({ ...ctx.user, environment: ctx.app.environment })),
  changePassword: sessionProcedure.input(z.object({ currentPassword: z.string(), newPassword: z.string() })).mutation(async ({ ctx, input }) => { await ctx.app.auth.changePassword(ctx.user.id, input.currentPassword, input.newPassword); return { ok: true }; }),
  mfaEnroll: sessionProcedure.mutation(({ ctx }) => ctx.app.auth.enrollMfa(ctx.user.id)),
  mfaEnable: sessionProcedure.input(z.object({ code: z.string() })).mutation(async ({ ctx, input }) => { await ctx.app.auth.setMfa(ctx.user.id, input.code, true); return { ok: true }; }),
  mfaDisable: guard().input(z.object({ code: z.string() })).mutation(async ({ ctx, input }) => { await ctx.app.auth.setMfa(ctx.user.id, input.code, false); return { ok: true }; }),
  directory: guard().query(({ ctx }) => ctx.app.auth.directory()),
});

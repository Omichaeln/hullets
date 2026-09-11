import { eq, and, isNull, gt, sql } from "drizzle-orm";
import { authenticator } from "otplib";
import { schema, type Db } from "@promo/db";
import { hashPassword, verifyPassword, randomHex, sha256, FieldCipher } from "../util/crypto.ts";
import { newId } from "../util/ids.ts";
import { err, invalid, conflict, notFound } from "../util/errors.ts";
import { ROLES, type Role } from "./policy.ts";
import type { AuditService } from "../audit.ts";

const { staffUsers, staffSessions } = schema;
export type StaffUser = { id: string; email: string; name: string; roles: string[]; status: string; mfaEnabled: boolean; mustChangePassword: boolean; lastLoginAt: string | null; createdAt: string };
const pub = (u: typeof staffUsers.$inferSelect): StaffUser => ({ id: u.id, email: u.email, name: u.name, roles: u.roles, status: u.status, mfaEnabled: u.mfaEnabled, mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt });
const strong = (pw: string) => typeof pw === "string" && pw.length >= 14 && /[a-z]/.test(pw) && /[A-Z0-9]/.test(pw);
/** 18 unambiguous characters in three groups; regenerated until it carries both a lower-case letter and an upper-case letter or digit. */
const tempPassword = (): string => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; let s = ""; const b = Buffer.from(randomHex(20), "hex"); for (let i = 0; i < 18; i++) s += a[b[i] % a.length]; const pw = `${s.slice(0, 6)}-${s.slice(6, 12)}-${s.slice(12)}`; return strong(pw) ? pw : tempPassword(); };

/**
 * Named staff accounts, scrypt passwords, opaque hashed session tokens, TOTP MFA
 * (secret encrypted at rest), temporary-password gate, and revocation on any
 * privilege change. Rate limiting is applied by the transport layer.
 */
export class AuthService {
  private cipher: FieldCipher; private pendingMfa = new Map<string, number>();
  constructor(private db: Db, private audit: AuditService, dataKey: string, private sessionHours = 12) { this.cipher = new FieldCipher(dataKey || "local-only-dev-key", "mfa"); }

  async bootstrap(email: string, password: string) {
    if (!email) return null;
    const ex = await this.byEmail(email); if (ex) return null;
    return this.createUser({ email, name: "Platform administrator", roles: ["platform_admin"], password, createdBy: "bootstrap", mustChangePassword: true });
  }
  async byEmail(email: string) { const [u] = await this.db.select().from(staffUsers).where(eq(staffUsers.email, email.toLowerCase().trim())); return u ?? null; }
  async get(id: string) { const [u] = await this.db.select().from(staffUsers).where(eq(staffUsers.id, id)); return u ? pub(u) : null; }
  async list() { return (await this.db.select().from(staffUsers).orderBy(staffUsers.createdAt)).map(pub); }
  async directory() { return (await this.list()).filter((u) => u.status === "active").map((u) => ({ id: u.id, name: u.name, email: u.email, roles: u.roles })); }

  async login({ email, password, ip }: { email: string; password: string; ip?: string }) {
    const u = await this.byEmail(email);
    if (!u || u.status !== "active" || !verifyPassword(password, u.passwordHash)) return null;
    if (u.mfaEnabled) { this.pendingMfa.set(u.id, Date.now() + 5 * 60_000); return { pendingMfa: true as const, userId: u.id }; }
    return { token: await this.issue(u.id, ip), user: pub(u) };
  }
  async verifyMfa({ userId, code, ip }: { userId: string; code: string; ip?: string }) {
    const until = this.pendingMfa.get(userId); if (!until || until < Date.now()) throw err("UNAUTHORIZED", "no pending MFA challenge; sign in again");
    const [u] = await this.db.select().from(staffUsers).where(eq(staffUsers.id, userId));
    if (!u?.mfaSecretEnc || !authenticator.check(String(code).replace(/\s/g, ""), this.cipher.decrypt(u.mfaSecretEnc))) throw err("UNAUTHORIZED", "invalid MFA code");
    this.pendingMfa.delete(userId);
    return { token: await this.issue(u.id, ip), user: pub(u) };
  }
  private async issue(userId: string, ip?: string) {
    const token = randomHex(32);
    await this.db.insert(staffSessions).values({ id: newId("ses"), userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + this.sessionHours * 3_600_000).toISOString(), ip: ip ?? null });
    await this.db.update(staffUsers).set({ lastLoginAt: new Date().toISOString() }).where(eq(staffUsers.id, userId));
    await this.audit.record(this.db, { actorType: "staff", actorId: userId, action: "staff.login", targetType: "staff_user", targetId: userId });
    return token;
  }
  async authenticate(bearer: string | undefined): Promise<StaffUser | null> {
    if (!bearer || !/^[a-f0-9]{64}$/.test(bearer)) return null;
    const [row] = await this.db.select({ s: staffSessions, u: staffUsers }).from(staffSessions).innerJoin(staffUsers, eq(staffUsers.id, staffSessions.userId)).where(and(eq(staffSessions.tokenHash, sha256(bearer)), isNull(staffSessions.revokedAt), gt(staffSessions.expiresAt, new Date().toISOString())));
    if (!row || row.u.status !== "active") return null;
    return pub(row.u);
  }
  async revoke(bearer: string) { await this.db.update(staffSessions).set({ revokedAt: new Date().toISOString() }).where(and(eq(staffSessions.tokenHash, sha256(bearer)), isNull(staffSessions.revokedAt))); }
  async revokeAllFor(userId: string) { await this.db.update(staffSessions).set({ revokedAt: new Date().toISOString() }).where(and(eq(staffSessions.userId, userId), isNull(staffSessions.revokedAt))); }

  async createUser({ email, name, roles, password, createdBy, mustChangePassword = true }: { email: string; name?: string; roles: string[]; password?: string; createdBy: string; mustChangePassword?: boolean }) {
    email = String(email || "").toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid("valid email required");
    const bad = roles.filter((r) => !(ROLES as readonly string[]).includes(r)); if (bad.length) throw invalid(`unknown roles: ${bad.join(", ")}`);
    if (await this.byEmail(email)) throw conflict("a user with that email exists");
    const pw = password || tempPassword(); if (!strong(pw)) throw invalid("password must be at least 14 characters with mixed case or digits");
    const id = newId("stf");
    await this.db.insert(staffUsers).values({ id, email, name: name || email, passwordHash: hashPassword(pw), roles: roles as Role[], status: "active", mustChangePassword, createdBy });
    await this.audit.record(this.db, { actorType: "staff", actorId: createdBy, action: "staff.create", targetType: "staff_user", targetId: id, payload: { email, roles } });
    return { user: (await this.get(id))!, temporaryPassword: password ? null : pw };
  }
  async updateUser(id: string, { roles, status, name }: { roles?: string[]; status?: string; name?: string }, actorId: string) {
    const u = await this.get(id); if (!u) throw notFound("user");
    if (roles) { const bad = roles.filter((r) => !(ROLES as readonly string[]).includes(r)); if (bad.length) throw invalid(`unknown roles: ${bad.join(", ")}`); }
    if (status && !["active", "disabled"].includes(status)) throw invalid("status must be active or disabled");
    await this.db.update(staffUsers).set({ roles: (roles ?? u.roles) as Role[], status: status ?? u.status, name: name ?? u.name, updatedAt: new Date().toISOString() }).where(eq(staffUsers.id, id));
    if (roles || (status && status !== "active")) await this.revokeAllFor(id);
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "staff.update", targetType: "staff_user", targetId: id, payload: { roles, status, name } });
    return (await this.get(id))!;
  }
  async changePassword(id: string, currentPassword: string, newPassword: string) {
    const [u] = await this.db.select().from(staffUsers).where(eq(staffUsers.id, id)); if (!u) throw notFound("user");
    if (!verifyPassword(currentPassword || "", u.passwordHash)) throw err("UNAUTHORIZED", "current password incorrect");
    if (!strong(newPassword)) throw invalid("new password must be at least 14 characters with mixed case or digits");
    await this.db.update(staffUsers).set({ passwordHash: hashPassword(newPassword), mustChangePassword: false, updatedAt: new Date().toISOString() }).where(eq(staffUsers.id, id));
    await this.revokeAllFor(id);
    await this.audit.record(this.db, { actorType: "staff", actorId: id, action: "staff.password_change", targetType: "staff_user", targetId: id });
  }
  async resetPassword(id: string, actorId: string) {
    const pw = tempPassword();
    const r = await this.db.update(staffUsers).set({ passwordHash: hashPassword(pw), mustChangePassword: true, updatedAt: new Date().toISOString() }).where(eq(staffUsers.id, id)).returning({ id: staffUsers.id });
    if (!r.length) throw notFound("user");
    await this.revokeAllFor(id);
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "staff.password_reset", targetType: "staff_user", targetId: id });
    return { temporaryPassword: pw };
  }
  async enrollMfa(id: string) {
    const u = await this.get(id); if (!u) throw notFound("user");
    const secret = authenticator.generateSecret();
    await this.db.update(staffUsers).set({ mfaSecretEnc: this.cipher.encrypt(secret), mfaEnabled: false }).where(eq(staffUsers.id, id));
    return { secret, otpauth: authenticator.keyuri(u.email, "Promo Engine", secret) };
  }
  async setMfa(id: string, code: string, enabled: boolean) {
    const [u] = await this.db.select().from(staffUsers).where(eq(staffUsers.id, id)); if (!u?.mfaSecretEnc) throw invalid("enrol an authenticator first");
    if (!authenticator.check(String(code).replace(/\s/g, ""), this.cipher.decrypt(u.mfaSecretEnc))) throw invalid("invalid MFA code");
    await this.db.update(staffUsers).set({ mfaEnabled: enabled }).where(eq(staffUsers.id, id));
    await this.audit.record(this.db, { actorType: "staff", actorId: id, action: enabled ? "staff.mfa_enabled" : "staff.mfa_disabled", targetType: "staff_user", targetId: id });
  }
  /** Test helper (never exposed): set a known password without the temporary gate. */
  async _setPasswordForTests(email: string, password: string) { await this.db.update(staffUsers).set({ passwordHash: hashPassword(password), mustChangePassword: false }).where(eq(staffUsers.email, email)); }
  countByRole(users: StaffUser[], role: string) { return users.filter((u) => u.status === "active" && u.roles.includes(role)); }
  static sql = sql;
}

import { eq, and, or, ilike, desc, sql, isNull } from "drizzle-orm";
import { schema, type Db, type DbOrTx } from "@promo/db";
import { newId } from "../util/ids.ts";
import { FieldCipher } from "../util/crypto.ts";
import { normalisePhone, maskPhone } from "../util/phone.ts";
import { invalid, conflict, notFound } from "../util/errors.ts";
import type { AuditService } from "../audit.ts";

const { participants, enrollments, campaigns } = schema;
export type Participant = typeof participants.$inferSelect;
const normIdentity = (v: string) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const maskIdentity = (v: string) => { const s = normIdentity(v); return s.length > 6 ? `${s.slice(0, 2)}${"*".repeat(s.length - 4)}${s.slice(-2)}` : "******"; };

/**
 * Reusable participant profile (one per channel identity), campaign enrollment
 * with the accepted notice versions, identity numbers under field-level
 * encryption with a keyed fingerprint, audited reveal, correction, withdrawal
 * and anonymisation that keeps ledger references.
 */
export class ParticipantService {
  private cipher: FieldCipher;
  constructor(private db: Db, private audit: AuditService, dataKey: string, private defaultCountryCode: string) { this.cipher = new FieldCipher(dataKey || "local-only-dev-key", "identity"); }
  uid(raw: string) { return normalisePhone(raw, this.defaultCountryCode); }
  mask(p: Participant | null) { return p ? { id: p.id, firstName: p.firstName, surname: p.surname, location: p.location, status: p.status, phone: maskPhone(p.channelUid), identityMask: p.identityMask, identityVerifiedAt: p.identityVerifiedAt, version: p.version, createdAt: p.createdAt } : null; }
  async byUid(uid: string) { const [p] = await this.db.select().from(participants).where(and(eq(participants.channel, "whatsapp"), eq(participants.channelUid, uid))); return p ?? null; }
  async get(id: string) { const [p] = await this.db.select().from(participants).where(eq(participants.id, id)); return p ?? null; }
  async enrollment(participantId: string, campaignId: string) { const [e] = await this.db.select().from(enrollments).where(and(eq(enrollments.participantId, participantId), eq(enrollments.campaignId, campaignId))); return e ?? null; }
  async enrollments(participantId: string) { return this.db.select({ e: enrollments, code: campaigns.code, name: campaigns.name }).from(enrollments).innerJoin(campaigns, eq(campaigns.id, enrollments.campaignId)).where(eq(enrollments.participantId, participantId)); }

  /** Create or update the profile from an authenticated channel event and enrol in the campaign. */
  async register(input: { uid: string; firstName: string; surname: string; location?: string | null; identity?: string | null; campaignId: string; campaignVersionId: string; termsVersion: string; privacyVersion: string; marketingConsent?: boolean; declarations?: Record<string, unknown>; correlationId?: string | null }) {
    if (!input.firstName?.trim()) throw invalid("first name required");
    return this.db.transaction(async (tx) => {
      let p = await this.byUid(input.uid); let created = false;
      const identityFields = input.identity ? { identityEnc: this.cipher.encrypt(normIdentity(input.identity)), identityMask: maskIdentity(input.identity), identityFp: this.cipher.fingerprint(normIdentity(input.identity)) } : {};
      if (p) {
        if (p.status !== "active") throw conflict(`participant is ${p.status}`);
        await tx.update(participants).set({ firstName: input.firstName.trim(), surname: (input.surname || "").trim(), location: input.location ?? p.location, ...identityFields, version: p.version + 1, updatedAt: new Date().toISOString() }).where(eq(participants.id, p.id));
      } else {
        created = true; const id = newId("ptc");
        await tx.insert(participants).values({ id, channel: "whatsapp", channelUid: input.uid, firstName: input.firstName.trim(), surname: (input.surname || "").trim(), location: input.location ?? null, ...identityFields });
        await this.audit.record(tx, { actorType: "participant", actorId: id, action: "participant.register", targetType: "participant", targetId: id, campaignId: input.campaignId, correlationId: input.correlationId, payload: { identityProvided: !!input.identity } });
      }
      const [fresh] = await tx.select().from(participants).where(and(eq(participants.channel, "whatsapp"), eq(participants.channelUid, input.uid)));
      p = fresh;
      const enr = await this.enrolIn(tx, p.id, input);
      return { participant: p, created, enrollment: enr };
    });
  }
  private async enrolIn(tx: DbOrTx, participantId: string, input: { campaignId: string; campaignVersionId: string; termsVersion: string; privacyVersion: string; marketingConsent?: boolean; declarations?: Record<string, unknown>; correlationId?: string | null }) {
    const values = { id: newId("enr"), participantId, campaignId: input.campaignId, campaignVersionId: input.campaignVersionId, termsVersion: input.termsVersion, privacyVersion: input.privacyVersion, marketingConsent: !!input.marketingConsent, declarations: input.declarations ?? {}, acceptedAt: new Date().toISOString(), withdrawnAt: null };
    await tx.insert(enrollments).values(values).onConflictDoUpdate({ target: [enrollments.participantId, enrollments.campaignId], set: { campaignVersionId: values.campaignVersionId, termsVersion: values.termsVersion, privacyVersion: values.privacyVersion, marketingConsent: values.marketingConsent, declarations: values.declarations, acceptedAt: values.acceptedAt, withdrawnAt: null } });
    await this.audit.record(tx, { actorType: "participant", actorId: participantId, action: "participant.enrol", targetType: "enrollment", targetId: participantId, campaignId: input.campaignId, correlationId: input.correlationId, payload: { termsVersion: input.termsVersion, privacyVersion: input.privacyVersion, marketingConsent: !!input.marketingConsent } });
    const [e] = await tx.select().from(enrollments).where(and(eq(enrollments.participantId, participantId), eq(enrollments.campaignId, input.campaignId))); return e;
  }
  async correct(id: string, patch: { firstName?: string; surname?: string; location?: string; identity?: string }, actorId: string, reason: string) {
    const p = await this.get(id); if (!p) throw notFound("participant"); if (!reason) throw invalid("reason required");
    const identityFields = patch.identity ? { identityEnc: this.cipher.encrypt(normIdentity(patch.identity)), identityMask: maskIdentity(patch.identity), identityFp: this.cipher.fingerprint(normIdentity(patch.identity)) } : {};
    await this.db.update(participants).set({ firstName: patch.firstName ?? p.firstName, surname: patch.surname ?? p.surname, location: patch.location ?? p.location, ...identityFields, version: p.version + 1, updatedAt: new Date().toISOString() }).where(eq(participants.id, id));
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "participant.correct", targetType: "participant", targetId: id, reason, payload: { fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] != null) } });
    return (await this.get(id))!;
  }
  async revealIdentity(id: string, actorId: string, reason: string) {
    if (!reason) throw invalid("reason required");
    const p = await this.get(id); if (!p) throw notFound("participant");
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "participant.identity.reveal", targetType: "participant", targetId: id, reason });
    return p.identityEnc ? this.cipher.decrypt(p.identityEnc) : null;
  }
  async markIdentityVerified(tx: DbOrTx, id: string, actorId: string, note: string | null) { await tx.update(participants).set({ identityVerifiedAt: new Date().toISOString() }).where(eq(participants.id, id)); await this.audit.record(tx, { actorType: "staff", actorId, action: "participant.identity.verified", targetType: "participant", targetId: id, reason: note }); }
  async withdraw(id: string, actorId: string | null, reason: string) {
    const p = await this.get(id); if (!p) throw notFound("participant");
    await this.db.transaction(async (tx) => {
      await tx.update(enrollments).set({ withdrawnAt: new Date().toISOString() }).where(and(eq(enrollments.participantId, id), isNull(enrollments.withdrawnAt)));
      await tx.update(participants).set({ status: "withdrawn", version: p.version + 1, updatedAt: new Date().toISOString() }).where(eq(participants.id, id));
      await this.audit.record(tx, { actorType: actorId ? "staff" : "participant", actorId: actorId ?? id, action: "participant.withdraw", targetType: "participant", targetId: id, reason });
    });
    return (await this.get(id))!;
  }
  /** Privacy deletion: personal fields removed and channel identity detached; ledger, audit and draw references remain. */
  async anonymise(id: string, actorId: string, reason: string) {
    const p = await this.get(id); if (!p) throw notFound("participant"); if (!reason) throw invalid("reason required");
    await this.db.transaction(async (tx) => {
      await tx.update(participants).set({ firstName: "[deleted]", surname: "", location: null, identityEnc: null, identityMask: null, identityFp: null, status: "deleted", channelUid: `deleted:${id}`, version: p.version + 1, updatedAt: new Date().toISOString() }).where(eq(participants.id, id));
      await tx.update(enrollments).set({ withdrawnAt: sql`coalesce(${enrollments.withdrawnAt}, now())` }).where(eq(enrollments.participantId, id));
      await this.audit.record(tx, { actorType: "staff", actorId, action: "participant.anonymise", targetType: "participant", targetId: id, reason });
    });
    return (await this.get(id))!;
  }
  /** Controlled phone change: never merges two participants. */
  async changePhone(id: string, newPhone: string, actorId: string, reason: string) {
    const uid = this.uid(newPhone); if (!uid) throw invalid("invalid phone number"); if (!reason) throw invalid("reason required");
    if (await this.byUid(uid)) throw conflict("another participant already uses that number");
    const p = await this.get(id); if (!p) throw notFound("participant");
    await this.db.update(participants).set({ channelUid: uid, version: p.version + 1, updatedAt: new Date().toISOString() }).where(eq(participants.id, id));
    await this.audit.record(this.db, { actorType: "staff", actorId, action: "participant.phone_change", targetType: "participant", targetId: id, reason, payload: { to: maskPhone(uid) } });
    return (await this.get(id))!;
  }
  async search({ q = "", campaignId = null, limit = 50, offset = 0 }: { q?: string; campaignId?: string | null; limit?: number; offset?: number }) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const conds = [q ? or(ilike(participants.firstName, like), ilike(participants.surname, like), ilike(participants.channelUid, like)) : undefined, campaignId ? sql`exists (select 1 from ${enrollments} where ${enrollments.participantId} = ${participants.id} and ${enrollments.campaignId} = ${campaignId})` : undefined].filter(Boolean);
    const rows = await this.db.select().from(participants).where(conds.length ? and(...(conds as never[])) : undefined).orderBy(desc(participants.createdAt)).limit(limit).offset(offset);
    return rows.map((p) => this.mask(p)!);
  }
}

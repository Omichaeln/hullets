import { useState } from "react";
import { trpc } from "../lib/trpc.ts";
import { useCan } from "../lib/auth.tsx";
import { Link, navigate } from "../lib/router.tsx";
import { PageHead, Card, Table, Badge, Button, Loading, ErrorBox, Input, KV, ActionDialog, useToast, Callout } from "../ui/kit.tsx";
import { fmtDate, titleCase } from "../lib/format.ts";
export function ParticipantsPage() {
  const [q, setQ] = useState(""); const [offset, setOffset] = useState(0); const list = trpc.participants.search.useQuery({ q: q || undefined, limit: 50, offset }); const stats = trpc.participants.stats.useQuery();
  return <>
    <PageHead title="Participants" sub={`Phone numbers and identity numbers are masked everywhere; reveal is a separate, audited action. ${stats.data ? `${stats.data.participants} registered.` : ""}`} actions={<Input placeholder="Search name or last digits…" value={q} onChange={(e) => { setOffset(0); setQ(e.target.value); }} style={{ width: 280 }} />} />
    <Card flush>{list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : <Table rows={list.data ?? []} keyOf={(p) => p.id} onRow={(p) => navigate(`/participants/${p.id}`)} cols={[{ h: "Name", c: (p) => `${p.firstName} ${p.surname}`.trim() }, { h: "Phone", c: (p) => <span className="mono">{p.phone}</span> }, { h: "Identity", c: (p) => <span className="mono">{p.identityMask ?? "–"}</span> }, { h: "Town", c: (p) => p.location ?? "–" }, { h: "Status", c: (p) => <Badge status={p.status} tone={p.status === "active" ? "success" : "danger"} /> }, { h: "Registered", c: (p) => fmtDate(p.createdAt) }]} />}
      <div className="tt-row" style={{ padding: 12 }}><Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button><Button size="sm" disabled={(list.data?.length ?? 0) < 50} onClick={() => setOffset(offset + 50)}>Next</Button></div>
    </Card>
  </>;
}
export function ParticipantDetailPage({ id }: { id: string }) {
  const q = trpc.participants.get.useQuery({ participantId: id }); const can = useCan(); const toast = useToast(); const utils = trpc.useUtils(); const refresh = () => utils.participants.get.invalidate({ participantId: id });
  const correct = trpc.participants.correct.useMutation({ onSuccess: refresh }); const reveal = trpc.participants.revealIdentity.useMutation(); const withdraw = trpc.participants.withdraw.useMutation({ onSuccess: refresh }); const anon = trpc.participants.anonymise.useMutation({ onSuccess: refresh }); const phone = trpc.participants.changePhone.useMutation({ onSuccess: refresh });
  const [dialog, setDialog] = useState<null | "correct" | "reveal" | "withdraw" | "anonymise" | "phone">(null); const [revealed, setRevealed] = useState<string | null>(null);
  if (q.isLoading) return <Loading />; if (q.error) return <ErrorBox error={q.error} />; const d = q.data!; const p = d.participant!;
  return <>
    <PageHead title={<>{p.firstName} {p.surname} <Badge status={p.status} tone={p.status === "active" ? "success" : "danger"} /></>} sub={<><span className="mono">{p.phone}</span> · {p.location ?? "no town"} · <Link to="/participants">All participants</Link></>} actions={<>
      {can("participant.correct") && <Button onClick={() => setDialog("correct")}>Correct details</Button>}
      {can("participant.identity.reveal") && <Button onClick={() => setDialog("reveal")}>Reveal identity</Button>}
      {can("participant.privacy") && p.status === "active" && <Button onClick={() => setDialog("phone")}>Change phone</Button>}
      {can("participant.privacy") && p.status === "active" && <Button variant="danger" onClick={() => setDialog("withdraw")}>Withdraw</Button>}
      {can("participant.privacy") && p.status !== "deleted" && <Button variant="danger" onClick={() => setDialog("anonymise")}>Anonymise</Button>}
    </>} />
    {revealed && <Callout tone="warning">Identity number (audited reveal): <span className="mono strong">{revealed}</span> <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>Hide</Button></Callout>}
    <div className="tt-grid c2" style={{ marginTop: 16 }}>
      <Card title="Profile"><KV rows={[["Identity", <span className="mono">{p.identityMask ?? "not captured"}</span>], ["Identity verified", p.identityVerifiedAt ? fmtDate(p.identityVerifiedAt) : "no"], ["Status", titleCase(p.status)], ["Registered", fmtDate(p.createdAt)], ["Record version", p.version]]} /></Card>
      <Card title="Enrolments"><Table rows={d.enrollments} keyOf={(x) => x.e.campaignId} cols={[{ h: "Campaign", c: (x) => <><span className="mono">{x.code}</span> <span className="small muted">{x.name}</span></> }, { h: "Terms", c: (x) => x.e.termsVersion }, { h: "Privacy", c: (x) => x.e.privacyVersion }, { h: "Marketing", c: (x) => x.e.marketingConsent ? "yes" : "no" }, { h: "Accepted", c: (x) => fmtDate(x.e.acceptedAt) }, { h: "Withdrawn", c: (x) => fmtDate(x.e.withdrawnAt) }]} /></Card>
      <Card title="Submissions"><Table rows={d.submissions} keyOf={(s) => s.id} onRow={(s) => navigate(`/submissions/${s.id}`)} cols={[{ h: "Reference", c: (s) => <span className="mono">{s.reference}</span> }, { h: "Period", c: (s) => s.periodCode ?? "–" }, { h: "Status", c: (s) => <Badge status={s.status} /> }, { h: "Reason", c: (s) => titleCase(s.reasonCode) }, { h: "Received", c: (s) => fmtDate(s.createdAt) }]} /></Card>
      <Card title="Entries"><Table rows={d.entries} keyOf={(e) => e.id} onRow={(e) => navigate(`/entries/${e.id}`)} cols={[{ h: "Entry", c: (e) => <span className="mono small">{e.id}</span> }, { h: "Period", c: (e) => e.periodCode ?? "–" }, { h: "Status", c: (e) => <Badge status={e.status} /> }, { h: "Awarded", c: (e) => fmtDate(e.awardedAt) }]} /></Card>
    </div>
    {dialog === "correct" && <ActionDialog title="Correct participant details" description="Only fields you fill in are changed. The correction is audited with your reason." fields={[{ key: "firstName", label: "First name" }, { key: "surname", label: "Surname" }, { key: "location", label: "Town" }, { key: "identity", label: "Identity number", help: "Stored encrypted; only the mask is shown afterwards." }, { key: "reason", label: "Reason", required: true }]} onConfirm={async (v) => { await correct.mutateAsync({ participantId: id, firstName: v.firstName || undefined, surname: v.surname || undefined, location: v.location || undefined, identity: v.identity || undefined, reason: v.reason }); toast.push("Corrected", "success"); }} onClose={() => setDialog(null)} />}
    {dialog === "reveal" && <ActionDialog title="Reveal identity number" description="Used for winner verification only. The reveal is written to the audit log with your reason." confirmLabel="Reveal" fields={[{ key: "reason", label: "Reason", required: true }]} onConfirm={async (v) => { const r = await reveal.mutateAsync({ participantId: id, reason: v.reason }); setRevealed(r.identity ?? "(none stored)"); }} onClose={() => setDialog(null)} />}
    {dialog === "phone" && <ActionDialog title="Change phone number" description="Never merges two participants: the new number must be unused." fields={[{ key: "phone", label: "New phone number", required: true }, { key: "reason", label: "Reason", required: true }]} onConfirm={async (v) => { await phone.mutateAsync({ participantId: id, phone: v.phone, reason: v.reason }); toast.push("Phone changed", "success"); }} onClose={() => setDialog(null)} />}
    {dialog === "withdraw" && <ActionDialog danger title="Withdraw participant" description="Ends their participation: no further entries, excluded from draws. Existing ledger records are kept." confirmLabel="Withdraw" fields={[{ key: "reason", label: "Reason", required: true }]} onConfirm={async (v) => { await withdraw.mutateAsync({ participantId: id, reason: v.reason }); toast.push("Withdrawn", "success"); }} onClose={() => setDialog(null)} />}
    {dialog === "anonymise" && <ActionDialog danger title="Anonymise participant (privacy deletion)" description="Removes name, town, identity number and detaches the phone number. Submissions, entries, draw and audit references remain for the ledger. This cannot be undone." confirmLabel="Anonymise" fields={[{ key: "reason", label: "Reason", required: true }]} onConfirm={async (v) => { await anon.mutateAsync({ participantId: id, reason: v.reason }); toast.push("Anonymised", "success"); }} onClose={() => setDialog(null)} />}
  </>;
}

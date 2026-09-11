import { useState } from "react";
import { trpc } from "../lib/trpc.ts";
import { useCan } from "../lib/auth.tsx";
import { Link } from "../lib/router.tsx";
import { PageHead, Card, Stat, Input, Loading, ErrorBox, Table, Badge, Button } from "../ui/kit.tsx";
import { fmtDate, titleCase } from "../lib/format.ts";
const day = (d: Date) => d.toISOString().slice(0, 10);
export function OverviewPage() {
  const can = useCan(); const [since, setSince] = useState(day(new Date(Date.now() - 30 * 86_400_000))); const [until, setUntil] = useState(day(new Date(Date.now() + 86_400_000)));
  const campaigns = trpc.campaigns.list.useQuery(); const [cid, setCid] = useState<string | undefined>(undefined);
  const rep = trpc.reports.summary.useQuery({ campaignId: cid, since: `${since}T00:00:00Z`, until: `${until}T00:00:00Z` });
  const queue = trpc.submissions.queue.useQuery(undefined, { enabled: can("submission.read"), refetchInterval: 30_000 });
  const alerts = trpc.ops.alerts.useQuery({}, { enabled: can("ops.read"), refetchInterval: 30_000 });
  const ack = trpc.ops.ackAlert.useMutation({ onSuccess: () => alerts.refetch() });
  const health = trpc.ops.healthHistory.useQuery({ sinceHours: 24 }, { enabled: can("ops.read"), refetchInterval: 60_000 });
  const r = rep.data; const by = (rows?: Array<{ k: string | null; n: number }>) => (rows ?? []).map((x) => `${titleCase(x.k)} ${x.n}`).join(" · ") || "–";
  return <>
    <PageHead title="Overview" sub="Reconciled counts straight from the ledger; every figure has a definition." actions={<>
      <select className="select" value={cid ?? ""} onChange={(e) => setCid(e.target.value || undefined)}><option value="">Current campaign</option>{campaigns.data?.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select>
      <Input type="date" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: 150 }} /><Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} style={{ width: 150 }} /></>} />
    {rep.error && <ErrorBox error={rep.error} />}
    {rep.isLoading ? <Loading /> : r && <div className="tt-stack">
      <div className="tt-grid c4">
        <Stat label="Registrations" value={r.registrations} hint={r.definitions.registrations} />
        <Stat label="Submissions" value={r.submissions} hint={by(r.submissions_by_status)} />
        <Stat label="Distinct purchases" value={r.canonical_receipts} hint={r.definitions.canonical_receipts} />
        <Stat label="Active entries" value={r.entries_active} hint={`${r.entries_excluded} excluded · ${r.unique_participants} participants`} />
        <Stat label="Review open" value={r.review_open} hint={queue.data ? `${queue.data.overdue} past target` : undefined} />
        <Stat label="Winners selected" value={r.winners_selected} hint={`${r.winners_verified} verified · ${r.prizes_fulfilled} fulfilled`} />
        <Stat label="Not qualified by reason" value={<span style={{ fontSize: 14 }}>{by(r.not_qualified_by_reason)}</span>} />
        <Stat label="Draws" value={<span style={{ fontSize: 14 }}>{by(r.draws_by_status)}</span>} />
      </div>
      {can("ops.read") && health.data && <div className="tt-grid c4">
        <Stat label="Availability, 24 h" value={health.data.availability.availabilityPct == null ? "–" : `${health.data.availability.availabilityPct.toFixed(2)}%`} hint={health.data.latest ? <>{health.data.latest.ok ? "healthy" : "degraded"} · sampled {fmtDate(health.data.latest.at)} · <Link to="/ops?tab=history">history</Link></> : "no samples yet"} />
        <Stat label="Errors, 24 h" value={health.data.errors.total} hint={<>{health.data.errors.open} unresolved · <Link to="/ops?tab=errors">error log</Link></>} />
        <Stat label="Inbound, 24 h" value={health.data.buckets.reduce((n, b) => n + b.inbound, 0)} hint={`${health.data.buckets.reduce((n, b) => n + b.outbound, 0)} messages sent`} />
        <Stat label="Waiting now" value={health.data.buckets.length ? health.data.buckets[health.data.buckets.length - 1].waitingEvents + health.data.buckets[health.data.buckets.length - 1].waitingJobs : 0} hint={health.data.buckets.length ? `${health.data.buckets[health.data.buckets.length - 1].deadLetters} dead letters · ${health.data.buckets[health.data.buckets.length - 1].reviewOverdue} reviews overdue` : undefined} />
      </div>}
      <div className="tt-grid c2">
        <Card title="Entries by period"><Table rows={r.entries_by_period} keyOf={(x) => String(x.k)} cols={[{ h: "Period", c: (x) => x.k ?? "–" }, { h: "Active entries", c: (x) => x.n, num: true }]} /></Card>
        <Card title="Entries by outlet"><Table rows={r.entries_by_outlet} keyOf={(x) => String(x.k)} cols={[{ h: "Outlet", c: (x) => x.k ?? "–" }, { h: "Active entries", c: (x) => x.n, num: true }]} /></Card>
      </div>
      {can("submission.read") && queue.data && <Card title={<h2>Review queue <span className="muted">({queue.data.count})</span></h2>} actions={<Link to="/submissions?tab=queue" className="btn sm">Open workspace</Link>}>
        <Table rows={queue.data.items.slice(0, 8)} keyOf={(x) => x.submissionId} onRow={(x) => { location.href = `/submissions/${x.submissionId}`; }} cols={[{ h: "Reference", c: (x) => <span className="mono">{x.reference}</span> }, { h: "Reason", c: (x) => titleCase(x.reason) }, { h: "State", c: (x) => <Badge status={x.state} /> }, { h: "Age", c: (x) => `${x.ageMinutes} min` }, { h: "Target", c: (x) => fmtDate(x.slaDueAt) }]} empty="Nothing waiting for review" />
      </Card>}
      {can("ops.read") && alerts.data && alerts.data.length > 0 && <Card title={<h2>Open alerts <span className="muted">({alerts.data.length})</span></h2>}>
        <Table rows={alerts.data} keyOf={(a) => a.id} cols={[{ h: "Severity", c: (a) => <Badge status={a.severity} /> }, { h: "Alert", c: (a) => <>{a.message}{a.runbook && <div className="small muted">Runbook: {a.runbook}</div>}</> }, { h: "Raised", c: (a) => fmtDate(a.createdAt) }, { h: "", c: (a) => can("ops.alerts.ack") ? <Button size="sm" onClick={() => ack.mutate({ id: a.id })}>Acknowledge</Button> : null }]} />
      </Card>}
    </div>}
  </>;
}

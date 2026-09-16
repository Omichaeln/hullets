/**
 * The campaign dashboard: where every platform user lands, the administrator
 * included. It is about ONE campaign — the one running, or the one being set up
 * — and answers the first questions anyone has on signing in: which promotion is
 * this, is it live, how is it doing, and where do I go to work on it.
 *
 * With no campaign at all there is nothing to summarise, so the page says so and
 * puts the one action that matters in the middle of the screen.
 */
import { useMemo, useState } from "react";
import { trpc } from "../lib/trpc.ts";
import { useCan, Restricted } from "../lib/auth.tsx";
import { Link, navigate, useQueryParams } from "../lib/router.tsx";
import { PageHead, Card, Stat, Input, Loading, ErrorBox, Table, Badge, Button, Select } from "../ui/kit.tsx";
import { fmtDate, fmtDay, titleCase } from "../lib/format.ts";

type CampaignRow = { id: string; code: string; name: string; description: string; status: string; startsAt: string; endsAt: string; timezone: string; sample: boolean; activeVersionNo: number | null; openDecisions: number };
/** Which campaign the dashboard shows when nobody chose: the live one, else the one being set up. */
const RANK: Record<string, number> = { active: 0, paused: 1, draft: 2, closed: 3, archived: 4 };
export function pickCampaign<T extends { status: string; createdAt?: string }>(rows: T[]): T | null {
  return [...rows].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0] ?? null;
}

export function DashboardPage() {
  const can = useCan(); const params = useQueryParams();
  const campaigns = trpc.campaigns.list.useQuery();
  const rows = (campaigns.data ?? []) as Array<CampaignRow & { createdAt: string }>;
  const chosen = params.get("campaign");
  const campaign = useMemo(() => rows.find((c) => c.id === chosen) ?? pickCampaign(rows), [rows, chosen]);
  if (campaigns.isLoading) return <Loading />;
  if (campaigns.error) return <><PageHead title="Dashboard" /><ErrorBox error={campaigns.error} /></>;
  if (!campaign) return <NoCampaign />;
  return <CampaignDashboard campaign={campaign} all={rows} canCreate={can("campaign.write")} />;
}

function NoCampaign() {
  const can = useCan();
  return <>
    <PageHead title="Dashboard" />
    <Card>
      <div className="dash-empty">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--tt-text-3)" }}><path d="M4 5h16v14H4zM4 10h16M9 5v14" /></svg>
        <h2>No campaign yet</h2>
        <p>A campaign is the promotion itself: what to buy, where, what it wins and when the draws are. Everything else on this console — receipts, entries, draws, winners — belongs to one.</p>
        {can("campaign.write")
          ? <Button variant="primary" size="lg" onClick={() => navigate("/campaigns/new")}>Create campaign</Button>
          : <Restricted perm="campaign.write" action="Creating a campaign" />}
      </div>
    </Card>
  </>;
}

function CampaignDashboard({ campaign: c, all, canCreate }: { campaign: CampaignRow; all: CampaignRow[]; canCreate: boolean }) {
  const can = useCan();
  const [since, setSince] = useState(""); const [until, setUntil] = useState("");
  const rep = trpc.reports.summary.useQuery({ campaignId: c.id, since: since ? `${since}T00:00:00Z` : undefined, until: until ? `${until}T23:59:59Z` : undefined });
  const queue = trpc.submissions.queue.useQuery(undefined, { enabled: can("submission.read"), refetchInterval: 30_000 });
  const alerts = trpc.ops.alerts.useQuery({}, { enabled: can("ops.read"), refetchInterval: 30_000 });
  const readiness = trpc.campaigns.activation.useQuery({ campaignId: c.id }, { enabled: c.status === "draft" });
  const ack = trpc.ops.ackAlert.useMutation({ onSuccess: () => alerts.refetch() });
  const r = rep.data; const by = (rows?: Array<{ k: string | null; n: number }>) => (rows ?? []).map((x) => `${titleCase(x.k)} ${x.n}`).join(" · ") || "–";
  const setupBlockers = (readiness.data?.failures ?? []).filter((f) => f.blocking && !PLATFORM_CODES.test(f.code)).length;
  const shortcuts: Array<{ to: string; label: string; hint: string; perm?: Parameters<typeof can>[0] }> = [
    { to: `/campaigns/${c.id}`, label: c.status === "draft" ? "Set up the campaign" : "Manage the campaign", hint: c.status === "draft" ? "Products, rules, prizes, outlets, readiness" : "Rules, prizes, periods, controls" },
    { to: "/submissions", label: "Submissions & review", hint: "Receipts as they arrive; the review queue", perm: "submission.read" },
    { to: "/entries", label: "Entries", hint: "What each receipt earned", perm: "entry.read" },
    { to: "/participants", label: "Participants", hint: "Who registered, masked", perm: "participant.read" },
    { to: "/draws", label: "Draws", hint: "Freeze, execute, approve, publish", perm: "draw.read" },
    { to: "/winners", label: "Winners & claims", hint: "Verification, prizes, results", perm: "winner.read" },
    { to: "/support", label: "Support", hint: "Participant queries", perm: "support.read" },
  ];
  return <>
    <PageHead
      title={<>{c.name} <Badge status={c.status} />{c.sample && <> <Badge tone="warning">sample</Badge></>}</>}
      sub={<><span className="mono">{c.code}</span> · {fmtDay(c.startsAt)} – {fmtDay(c.endsAt)} · {c.timezone}{c.activeVersionNo ? ` · configuration v${c.activeVersionNo} live` : " · no live configuration"}{c.description ? <><br />{c.description}</> : null}</>}
      actions={<>
        {all.length > 1 && <Select value={c.id} onChange={(e) => navigate(`/?campaign=${e.target.value}`)} aria-label="Campaign" style={{ width: "auto" }}>{all.map((x) => <option key={x.id} value={x.id}>{x.code} · {titleCase(x.status)}</option>)}</Select>}
        <Link to={`/campaigns/${c.id}`} className="btn">{c.status === "draft" ? "Continue set-up" : "Manage campaign"}</Link>
        {canCreate && <Link to="/campaigns/new" className="btn primary">Create campaign</Link>}
      </>} />
    <div className="tt-stack">
      {c.status === "draft" && <Card title="Before this campaign can go live">
        {readiness.isLoading ? <Loading /> : <div className="tt-row" style={{ justifyContent: "space-between" }}>
          <div>{setupBlockers === 0 ? <>The configuration is complete. Activation happens under <Link to={`/campaigns/${c.id}?s=readiness`}>Readiness</Link>.</> : <><strong>{setupBlockers}</strong> configuration item{setupBlockers === 1 ? "" : "s"} still missing. Readiness lists each one with where to fix it.</>}</div>
          <Link to={`/campaigns/${c.id}?s=readiness`} className="btn sm">Open readiness</Link>
        </div>}
      </Card>}
      <Card title="Go to" flush><div className="body"><div className="dash-shortcuts">{shortcuts.filter((s) => !s.perm || can(s.perm)).map((s) => <Link key={s.to} to={s.to} className="dash-shortcut"><strong>{s.label}</strong><span>{s.hint}</span></Link>)}</div></div></Card>
      <Card title="Performance" actions={<div className="tt-row"><label className="small muted" htmlFor="dash-since">From</label><Input id="dash-since" type="date" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: 150 }} /><label className="small muted" htmlFor="dash-until">To</label><Input id="dash-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} style={{ width: 150 }} /></div>}>
        {rep.error ? <ErrorBox error={rep.error} /> : rep.isLoading || !r ? <Loading /> : <>
          <p className="small muted" style={{ marginTop: 0 }}>Reconciled counts straight from the ledger{since || until ? " for the chosen dates" : " for the whole campaign"}; every figure has a definition.</p>
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
        </>}
      </Card>
      {r && <div className="tt-grid c2">
        <Card title="Entries by period"><Table rows={r.entries_by_period} keyOf={(x) => String(x.k)} cols={[{ h: "Period", c: (x) => x.k ?? "–" }, { h: "Active entries", c: (x) => x.n, num: true }]} empty="No entries yet" /></Card>
        <Card title="Entries by outlet"><Table rows={r.entries_by_outlet} keyOf={(x) => String(x.k)} cols={[{ h: "Outlet", c: (x) => x.k ?? "–" }, { h: "Active entries", c: (x) => x.n, num: true }]} empty="No entries yet" /></Card>
      </div>}
      {can("submission.read") && queue.data && <Card title={<h2>Review queue <span className="muted">({queue.data.count})</span></h2>} actions={<Link to="/submissions?tab=queue" className="btn sm">Open workspace</Link>}>
        <Table rows={queue.data.items.slice(0, 8)} keyOf={(x) => x.submissionId} onRow={(x) => navigate(`/submissions/${x.submissionId}`)} cols={[{ h: "Reference", c: (x) => <span className="mono">{x.reference}</span> }, { h: "Reason", c: (x) => titleCase(x.reason) }, { h: "State", c: (x) => <Badge status={x.state} /> }, { h: "Age", c: (x) => `${x.ageMinutes} min` }, { h: "Target", c: (x) => fmtDate(x.slaDueAt) }]} empty="Nothing waiting for review" />
      </Card>}
      {can("ops.read") && alerts.data && alerts.data.length > 0 && <Card title={<h2>Open alerts <span className="muted">({alerts.data.length})</span></h2>}>
        <Table rows={alerts.data} keyOf={(a) => a.id} cols={[{ h: "Severity", c: (a) => <Badge status={a.severity} /> }, { h: "Alert", c: (a) => <>{a.message}{a.runbook && <div className="small muted">Runbook: {a.runbook}</div>}</> }, { h: "Raised", c: (a) => fmtDate(a.createdAt) }, { h: "", c: (a) => can("ops.alerts.ack") ? <Button size="sm" onClick={() => ack.mutate({ id: a.id })}>Acknowledge</Button> : null }]} />
      </Card>}
    </div>
  </>;
}
/** Validator codes about the installation and its sign-offs rather than the campaign's own configuration. */
export const PLATFORM_CODES = /^(ENVIRONMENT|TRANSPORT|EXTRACTOR|CRM|DATA_KEY|AUDIT_SIGNING_KEY|WEBHOOK_SECRETS|RECIPIENT_ALLOWLIST|STAFF_|EVIDENCE_)/;

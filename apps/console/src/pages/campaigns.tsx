/**
 * The Campaigns area: the list, and the page that creates one.
 *
 * Creating a campaign is deliberately short — a name, a code, the window — and
 * lands the person in the set-up flow, where every other decision has its own
 * section with its own explanation. A newly created campaign is a DRAFT: it is
 * invisible to participants until its configuration is activated and the
 * campaign itself is set live, both of which happen under Readiness.
 */
import { useState } from "react";
import { trpc, errorMessage } from "../lib/trpc.ts";
import { useCan, Restricted } from "../lib/auth.tsx";
import { Link, navigate } from "../lib/router.tsx";
import { PageHead, Card, Table, Badge, Button, Loading, ErrorBox, Field, Input, Textarea, Callout, useToast } from "../ui/kit.tsx";
import { fmtDay } from "../lib/format.ts";

export function CampaignsPage() {
  const q = trpc.campaigns.list.useQuery(); const can = useCan();
  if (q.isLoading) return <Loading />; if (q.error) return <ErrorBox error={q.error} />;
  const rows = q.data ?? [];
  return <>
    <PageHead title="Campaigns" sub="Each campaign is a promotion: its products, rules, prizes, outlets and draw schedule, kept as versions and activated under control."
      actions={can("campaign.write") ? <Link to="/campaigns/new" className="btn primary">Create campaign</Link> : <Restricted perm="campaign.write" action="Creating or editing a campaign" />} />
    {rows.length === 0 ? <Card><div className="dash-empty"><h2>No campaigns yet</h2><p>Create the first one to start configuring products, rules, prizes and outlets. It stays a draft until you activate it.</p>{can("campaign.write") ? <Button variant="primary" size="lg" onClick={() => navigate("/campaigns/new")}>Create campaign</Button> : <Restricted perm="campaign.write" action="Creating a campaign" />}</div></Card>
    : <Card flush><Table rows={rows} keyOf={(c) => c.id} onRow={(c) => navigate(`/campaigns/${c.id}`)} cols={[
      { h: "Campaign", c: (c) => <><div className="strong">{c.name}</div><div className="small muted"><span className="mono">{c.code}</span>{c.sample && <> · <Badge tone="warning">sample</Badge></>}</div></> },
      { h: "Status", c: (c) => <Badge status={c.status} /> },
      { h: "Window", c: (c) => `${fmtDay(c.startsAt)} – ${fmtDay(c.endsAt)}` },
      { h: "Configuration", c: (c) => c.activeVersionNo ? `v${c.activeVersionNo} live` : <span className="muted">draft only</span> },
      { h: "Open decisions", c: (c) => c.openDecisions ? <Badge tone="warning">{c.openDecisions}</Badge> : "0" },
      { h: "Controls", c: (c) => [c.controls.pauseIntake && "intake paused", c.controls.pauseOutbound && "outbound paused", c.controls.pauseDraws && "draws paused", c.controls.pauseAutoQualify && "auto-qualify paused"].filter(Boolean).join(", ") || "normal" },
    ]} /></Card>}
  </>;
}

/** Time zones offered for the campaign clock; anything IANA is accepted, these are just the likely ones first. */
export function timezoneOptions(): string[] {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  const africa = all.filter((z) => z.startsWith("Africa/"));
  return ["Africa/Harare", "Africa/Johannesburg", "Africa/Lusaka", "Africa/Maputo", "Africa/Nairobi", "Africa/Lagos", "UTC", ...africa.filter((z) => !["Africa/Harare", "Africa/Johannesburg", "Africa/Lusaka", "Africa/Maputo", "Africa/Nairobi", "Africa/Lagos"].includes(z))];
}
export const suggestCode = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
export const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

export function NewCampaignPage() {
  const can = useCan(); const toast = useToast();
  const mk = trpc.campaigns.create.useMutation();
  const [f, setF] = useState({ name: "", code: "", codeTouched: false, description: "", startsAt: "", endsAt: "", timezone: "Africa/Harare" });
  const [err, setErr] = useState<string | null>(null);
  if (!can("campaign.write")) return <><PageHead title="Create campaign" /><Callout tone="warning"><Restricted perm="campaign.write" action="Creating a campaign" /> Ask a platform administrator under Access if you need it.</Callout></>;
  const problems: string[] = [];
  if (!f.name.trim()) problems.push("a name");
  if (!CODE_RE.test(f.code)) problems.push("a code of 3–40 capital letters, digits or dashes");
  if (!f.startsAt || !f.endsAt) problems.push("a start and an end");
  else if (new Date(f.endsAt) <= new Date(f.startsAt)) problems.push("an end after the start");
  const submit = async () => {
    setErr(null);
    try {
      const c = await mk.mutateAsync({ code: f.code, name: f.name.trim(), description: f.description.trim() || undefined, startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(), timezone: f.timezone.trim() || undefined });
      toast.push("Campaign created as a draft", "success"); navigate(`/campaigns/${c.campaign.id}?s=products`);
    } catch (e) { setErr(errorMessage(e)); }
  };
  return <>
    <PageHead title="Create campaign" sub={<>A draft: invisible to participants until it is activated under Readiness. <Link to="/campaigns">Back to campaigns</Link></>} />
    <div className="tt-grid" style={{ gridTemplateColumns: "minmax(0, 640px)" }}>
      <Card title="The basics">
        <div className="tt-col">
          <Field label="Name" help="What the promotion is called to participants — it appears in the WhatsApp welcome."><Input value={f.name} maxLength={120} autoFocus onChange={(e) => setF({ ...f, name: e.target.value, code: f.codeTouched ? f.code : suggestCode(e.target.value) })} placeholder="e.g. Huletts Summer Sugar Promotion" /></Field>
          <Field label="Code" help="A stable identifier used in exports, the audit log and support. Capital letters, digits and dashes; it cannot change later." error={f.code && !CODE_RE.test(f.code) ? "3–40 characters: A–Z, 0–9 and dashes, starting with a letter or digit." : undefined}><Input mono value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase(), codeTouched: true })} placeholder="HULETTS-SUMMER-2026" /></Field>
          <Field label="Description" help="For the team, not for participants: what this campaign is and anything the next person should know."><Textarea value={f.description} maxLength={2000} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <div className="form-row">
            <Field label="Starts" help="Registrations and receipts are accepted from this moment."><Input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></Field>
            <Field label="Ends" help="After this, participants are told the promotion has closed."><Input type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></Field>
          </div>
          <Field label="Time zone" help="The clock that periods, draw times and receipt dates are read in."><Input list="tz-options" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /><datalist id="tz-options">{timezoneOptions().map((z) => <option key={z} value={z} />)}</datalist></Field>
        </div>
        {err && <Callout tone="danger">{err}</Callout>}
        <div className="setup-foot">
          <span className="small muted">{problems.length ? `Still needed: ${problems.join(", ")}.` : "Products, rules, prizes and outlets come next, each in its own section."}</span>
          <span className="spacer" />
          <Button onClick={() => navigate("/campaigns")}>Cancel</Button>
          <Button variant="primary" loading={mk.isPending} disabled={problems.length > 0} onClick={submit}>Create draft campaign</Button>
        </div>
      </Card>
    </div>
    <p className="small muted" style={{ marginTop: 16 }}>What happens next: the draft gets configuration v1. You add qualifying products, the entry rules, registration and receipt requirements, terms and messages, prizes and draw periods, and the participating outlets. Readiness then lists anything still missing before activation.</p>
  </>;
}

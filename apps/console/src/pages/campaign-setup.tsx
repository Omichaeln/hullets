/**
 * Campaign set-up and management: one campaign, one section at a time.
 *
 * Everything here already existed in the backend — versioned rules, content,
 * flags and prize plan; periods; outlets; the decision register; the pause
 * controls; the activation validator. What did not exist was a way to work on it
 * without typing JSON. Each section below edits one part of the configuration
 * with fields that say what they mean, and Readiness turns the validator's codes
 * into "what is missing and where to fix it".
 *
 * Protections that hold throughout, all enforced by the server:
 *  - an ACTIVE configuration version is immutable. Saving a change to a campaign
 *    whose configuration is live creates a new DRAFT version; participants keep
 *    the live one until the draft is activated (campaign.write);
 *  - a drawn period cannot be edited;
 *  - a closed or archived campaign cannot be edited;
 *  - going live is campaign.activate, and in production runs the validator first.
 */
import { useMemo, useState, type ReactNode } from "react";
import { trpc, errorMessage, type RouterOutputs } from "../lib/trpc.ts";
import { useCan, Restricted, roleLabel, whoCan } from "../lib/auth.tsx";
import { Link, navigate, useQueryParams } from "../lib/router.tsx";
import { PageHead, Card, Table, Badge, Button, Loading, ErrorBox, KV, Field, Input, Textarea, Select, Checkbox, ActionDialog, Modal, Json, Callout, useToast } from "../ui/kit.tsx";
import { fmtDate, fmtDay, titleCase } from "../lib/format.ts";
import { Rules, Content, Flags, PrizePlan, type Rules as RulesT, type Content as ContentT, type Flags as FlagsT, type PrizePlan as PrizePlanT } from "@promo/core/campaign/types.ts";
import { MESSAGES } from "@promo/core/conversation/copy.ts";
import { PLATFORM_CODES } from "./dashboard.tsx";
import { timezoneOptions } from "./campaigns.tsx";

type Detail = RouterOutputs["campaigns"]["get"];
type Version = Detail["versions"][number];
type SectionId = "overview" | "basics" | "products" | "rules" | "registration" | "content" | "prizes" | "outlets" | "team" | "decisions" | "readiness";
const SECTIONS: Array<{ id: SectionId; label: string; hint: string; group?: string }> = [
  { id: "overview", label: "Overview", hint: "Status, versions, next steps" },
  { id: "basics", label: "Basics", hint: "Name, description, dates, status", group: "Set up" },
  { id: "products", label: "Products & qualification", hint: "What to buy, how much" },
  { id: "rules", label: "Entry rules", hint: "Limits, eligibility, matching" },
  { id: "registration", label: "Registration & receipts", hint: "What participants provide" },
  { id: "content", label: "Terms & messages", hint: "Terms, prizes copy, artwork" },
  { id: "prizes", label: "Prizes & draws", hint: "Prize tiers, periods, collection" },
  { id: "outlets", label: "Participating outlets", hint: "Where receipts may come from" },
  { id: "team", label: "Team & controls", hint: "Who does what; pause switches", group: "Run" },
  { id: "decisions", label: "Client decisions", hint: "Sign-offs the launch needs" },
  { id: "readiness", label: "Readiness & activation", hint: "What is missing; go live" },
];
/** Where a validator failure is fixed. Anything not listed is about the installation, not the campaign. */
function sectionFor(code: string): SectionId | null {
  if (/^RULES_/.test(code)) return "products";
  if (/^CONTENT_|^WINNER_TEMPLATE/.test(code)) return "content";
  if (/^PRIZES_|^PERIODS_/.test(code)) return "prizes";
  if (/^OUTLETS_/.test(code)) return "outlets";
  if (/^DECISION_/.test(code)) return "decisions";
  if (/^SAMPLE_/.test(code)) return "basics";
  if (/^NO_ACTIVE_VERSION/.test(code)) return "readiness";
  if (/^STAFF_/.test(code)) return "team";
  return null;
}

export function CampaignDetailPage({ id }: { id: string }) {
  const q = trpc.campaigns.get.useQuery({ campaignId: id }); const params = useQueryParams();
  const section = (SECTIONS.some((s) => s.id === params.get("s")) ? params.get("s") : "overview") as SectionId;
  const readiness = trpc.campaigns.activation.useQuery({ campaignId: id });
  if (q.isLoading) return <Loading />; if (q.error) return <ErrorBox error={q.error} />; const d = q.data!; const c = d.campaign;
  const missing = new Set((readiness.data?.failures ?? []).filter((f) => f.blocking).map((f) => sectionFor(f.code)).filter(Boolean));
  const go = (s: SectionId) => `/campaigns/${id}?s=${s}`;
  const w = working(d);
  const body: Record<SectionId, ReactNode> = {
    overview: <OverviewSection d={d} w={w} failures={readiness.data?.failures ?? []} go={go} />,
    basics: <BasicsSection d={d} key={c.updatedAt} />,
    products: <ProductsSection key={w.key} d={d} w={w} next={go("rules")} />,
    rules: <RulesSection key={w.key} d={d} w={w} next={go("registration")} />,
    registration: <RegistrationSection key={w.key} d={d} w={w} next={go("content")} />,
    content: <ContentSection key={w.key} d={d} w={w} next={go("prizes")} />,
    prizes: <PrizesSection key={w.key} d={d} w={w} next={go("outlets")} />,
    outlets: <OutletsSection campaignId={id} />,
    team: <TeamSection d={d} />,
    decisions: <DecisionsSection campaignId={id} decisions={d.decisions} />,
    readiness: <ReadinessSection d={d} w={w} failures={readiness.data?.failures ?? []} loading={readiness.isLoading} refetch={() => readiness.refetch()} go={go} />,
  };
  return <>
    <PageHead title={<>{c.name} <Badge status={c.status} />{c.sample && <> <Badge tone="warning">sample</Badge></>}</>}
      sub={<><span className="mono">{c.code}</span> · {fmtDay(c.startsAt)} – {fmtDay(c.endsAt)} · {c.timezone} · <Link to="/campaigns">All campaigns</Link> · <Link to={`/?campaign=${c.id}`}>Dashboard</Link></>}
      actions={<StatusActions d={d} />} />
    <div className="setup">
      <nav className="setup-nav" aria-label="Campaign sections">{SECTIONS.map((s) => <span key={s.id} style={{ display: "contents" }}>{s.group && <div className="group">{s.group}</div>}<Link to={go(s.id)} className={s.id === section ? "active" : ""} aria-current={s.id === section ? "page" : undefined}>{s.label}<small>{s.hint}</small>{missing.has(s.id) && s.id !== "readiness" && <span className="badge warning">needs attention</span>}</Link></span>)}</nav>
      <div className="setup-body">{body[section]}</div>
    </div>
  </>;
}

/* ------------------------------------------------------------------ the working version */
type Working = { draft: Version | null; live: Version | null; base: Version | null; key: string; rules: RulesT; content: ContentT; flags: FlagsT; plan: PrizePlanT };
/** Which version the sections edit: the open draft, else the live one (a save then opens a draft). */
function working(d: Detail): Working {
  const draft = [...d.versions].reverse().find((v) => v.status === "draft") ?? null;
  const live = d.activeVersion ?? null; const base = draft ?? live ?? d.versions.at(-1) ?? null;
  return { draft, live, base, key: base ? `${base.id}:${base.configHash}` : "none", rules: Rules.parse(base?.rules ?? {}), content: Content.parse(base?.content ?? {}), flags: Flags.parse(base?.flags ?? {}), plan: PrizePlan.parse(base?.prizePlan ?? {}) };
}
/** Saves a part of the configuration into the draft, opening one from the live version when there is none. */
function useSaveVersion(d: Detail, w: Working) {
  const utils = trpc.useUtils(); const toast = useToast();
  const createV = trpc.campaigns.createVersion.useMutation(); const updateV = trpc.campaigns.updateVersion.useMutation();
  const refresh = () => Promise.all([utils.campaigns.get.invalidate({ campaignId: d.campaign.id }), utils.campaigns.activation.invalidate({ campaignId: d.campaign.id })]);
  const save = async (patch: { rules?: RulesT; content?: ContentT; flags?: FlagsT; prizePlan?: PrizePlanT }) => {
    try {
      if (w.draft) await updateV.mutateAsync({ versionId: w.draft.id, ...patch });
      else await createV.mutateAsync({ campaignId: d.campaign.id, fromActive: true, ...patch });
      await refresh(); toast.push(w.draft ? "Draft saved" : `Saved into a new draft, v${d.versions.length + 1}`, "success"); return true;
    } catch (e) { toast.push(errorMessage(e), "error"); return false; }
  };
  return { save, saving: createV.isPending || updateV.isPending, refresh };
}
function VersionNote({ d, w }: { d: Detail; w: Working }) {
  const closed = ["closed", "archived"].includes(d.campaign.status);
  if (closed) return <Callout tone="info">This campaign is {d.campaign.status}; its configuration is kept for the record and cannot change.</Callout>;
  if (w.draft && w.live) return <div className="setup-version"><Badge tone="info">editing draft v{w.draft.versionNo}</Badge><span className="muted">v{w.live.versionNo} is live and stays in force until the draft is activated under Readiness.</span></div>;
  if (w.draft) return <div className="setup-version"><Badge tone="info">draft v{w.draft.versionNo}</Badge><span className="muted">Nothing is live yet; participants cannot see this campaign.</span></div>;
  if (w.live) return <div className="setup-version"><Badge tone="success">v{w.live.versionNo} live</Badge><span className="muted">A live version cannot be edited. Saving a change opens draft v{d.versions.length + 1}; participants keep v{w.live.versionNo} until it is activated.</span></div>;
  return null;
}
function SaveBar({ dirty, saving, onSave, onDiscard, next, problems, editable }: { dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void; next?: string; problems?: string[]; editable: boolean }) {
  return <div className="setup-foot">
    {!editable ? <Restricted perm="campaign.write" action="Editing" /> : problems?.length ? <span className="small" style={{ color: "var(--tt-danger-text)" }}>{problems[0]}</span> : <span className="small muted">{dirty ? "Unsaved changes." : "Saved."}</span>}
    <span className="spacer" />
    {editable && <><Button variant="ghost" disabled={!dirty || saving} onClick={onDiscard}>Discard</Button><Button variant="primary" loading={saving} disabled={!dirty || !!problems?.length} onClick={onSave}>Save</Button></>}
    {next && <Link to={next} className="btn">Next section</Link>}
  </div>;
}
function useEditable(d: Detail) { const can = useCan(); return can("campaign.write") && !["closed", "archived"].includes(d.campaign.status); }
const num = (v: string, int = true) => { if (v.trim() === "") return null; const n = Number(v); return Number.isFinite(n) ? (int ? Math.trunc(n) : n) : null; };
const local = (iso?: string | null) => { if (!iso) return ""; const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

/* ------------------------------------------------------------------ status */
function StatusActions({ d }: { d: Detail }) {
  const can = useCan(); const toast = useToast(); const utils = trpc.useUtils(); const c = d.campaign;
  const refresh = () => utils.campaigns.get.invalidate({ campaignId: c.id });
  const setStatus = trpc.campaigns.setStatus.useMutation({ onSuccess: refresh }); const clone = trpc.campaigns.clone.useMutation();
  const [dialog, setDialog] = useState<null | "status" | "clone">(null);
  const next: Record<string, string[]> = { draft: ["active"], active: ["paused", "closed"], paused: ["active", "closed"], closed: ["archived"], archived: [] };
  const options = (next[c.status] ?? []).filter((s) => s !== "active" || d.activeVersion);
  return <>
    {can("campaign.activate") && options.length > 0 && <Button onClick={() => setDialog("status")}>Change status</Button>}
    {!can("campaign.activate") && (next[c.status] ?? []).length > 0 && <Restricted perm="campaign.activate" action="Changing the campaign's status" />}
    {can("campaign.write") && <Button onClick={() => setDialog("clone")}>Clone</Button>}
    {dialog === "status" && <ActionDialog title="Change campaign status" description={<>Current status: <strong>{titleCase(c.status)}</strong>. {c.status === "draft" ? "Going live makes the campaign visible to participants at once. In production the validator runs first and refuses if anything blocking is missing." : c.status === "active" ? "Pausing tells participants entries are paused; closing ends the promotion and cannot be undone." : ""}</>} fields={[{ key: "status", label: "New status", type: "select", required: true, options: options.map((s) => ({ value: s, label: titleCase(s) })) }, { key: "reason", label: "Reason (recorded in the audit log)", type: "textarea" }]} onConfirm={async (v) => { await setStatus.mutateAsync({ campaignId: c.id, status: v.status as "active" | "paused" | "closed" | "archived", reason: v.reason || undefined }); toast.push(`Campaign is now ${v.status}`, "success"); }} onClose={() => setDialog(null)} />}
    {dialog === "clone" && <ActionDialog title="Clone campaign" description="Copies the configuration, outlets and decision questions into a new draft campaign with no participants, submissions or draws." fields={[{ key: "code", label: "New code", required: true }, { key: "name", label: "Name" }]} confirmLabel="Clone" onConfirm={async (v) => { const n = await clone.mutateAsync({ campaignId: c.id, code: v.code.toUpperCase(), name: v.name || undefined }); navigate(`/campaigns/${n.campaign.id}`); }} onClose={() => setDialog(null)} />}
  </>;
}

/* ------------------------------------------------------------------ overview */
function OverviewSection({ d, w, failures, go }: { d: Detail; w: Working; failures: Array<{ code: string; message: string; blocking: boolean }>; go: (s: SectionId) => string }) {
  const c = d.campaign; const config = failures.filter((f) => !PLATFORM_CODES.test(f.code));
  const steps = config.slice(0, 6);
  return <div className="tt-stack">
    <Card title="Summary"><KV rows={[["Status", <Badge status={c.status} />], ["Description", c.description || <span className="muted">none</span>], ["Window", `${fmtDate(c.startsAt)} → ${fmtDate(c.endsAt)} (${c.timezone})`], ["Live configuration", w.live ? `v${w.live.versionNo} · activated ${fmtDate(w.live.activatedAt)}` : "none — participants see a closed promotion"], ["Open draft", w.draft ? `v${w.draft.versionNo} · ${w.draft.configHash.slice(0, 12)}…` : "none"], ["Qualification", `${w.rules.qualification.mode === "weight" ? `at least ${w.rules.qualification.minTotalGrams} g in total` : `at least ${w.rules.qualification.minPacks} × ${w.rules.qualification.packGrams} g packs`} of ${w.rules.products.filter((p) => p.qualifying).length} qualifying product(s)`], ["Prizes", w.plan.tiers.length ? w.plan.tiers.map((t) => `${t.count} × ${t.label}`).join("; ") : "none"], ["Periods", d.periods.map((p) => `${p.code} (${p.status})`).join(", ") || "none"], ["Outlets", d.outletCount], ["Created", `${fmtDate(c.createdAt)}${c.createdBy ? ` by ${c.createdBy}` : ""}`]]} /></Card>
    <Card title={c.status === "draft" ? "What is left before going live" : "Configuration checks"}>
      {steps.length === 0 ? <p className="muted" style={{ margin: 0 }}>The campaign's own configuration is complete. {c.status === "draft" && <>Activate it under <Link to={go("readiness")}>Readiness</Link>.</>}</p>
      : <div className="check-list">{steps.map((f) => { const s = sectionFor(f.code); return <div key={f.code} className="check-item"><span className="mark no">!</span><div className="what">{explain(f)}<small>{f.message}</small></div>{s && <Link to={go(s)} className="btn sm">Fix</Link>}</div>; })}{config.length > steps.length && <p className="small muted">…and {config.length - steps.length} more under <Link to={go("readiness")}>Readiness</Link>.</p>}</div>}
    </Card>
    <Card title="Versions">
      <Table rows={d.versions} keyOf={(v) => v.id} cols={[{ h: "Version", c: (v) => `v${v.versionNo}` }, { h: "Status", c: (v) => <Badge status={v.status} /> }, { h: "Configuration hash", c: (v) => <span className="mono small">{v.configHash.slice(0, 16)}</span> }, { h: "Created", c: (v) => fmtDate(v.createdAt) }, { h: "Activated", c: (v) => fmtDate(v.activatedAt) }]} empty="No versions." />
      <p className="small muted" style={{ marginBottom: 0 }}>Activating a version applies prospectively: receipts already decided keep the version they were judged under.</p>
    </Card>
  </div>;
}
/** Three reasons in full; the rest as a count, so twenty-two open decisions do not become a wall. */
function summarise(items: string[]): string { if (!items.length) return "Missing"; if (items.length <= 3) return items.join("; "); return `${items.slice(0, 2).join("; ")}; and ${items.length - 2} more`; }
/** The validator's code, in the words of the person who has to fix it. */
function explain(f: { code: string; message: string }): string {
  const m: Record<string, string> = { NO_ACTIVE_VERSION: "Activate a configuration version", RULES_PRODUCTS: "Add at least one qualifying product", CONTENT_TERMS: "Set the terms version and link", CONTENT_PRIZES: "Describe the prizes for participants", WINNER_TEMPLATE: "Name the approved winner message template", PRIZES_EMPTY: "Add at least one prize tier", PERIODS_EMPTY: "Add at least one draw period", OUTLETS_EMPTY: "Choose the participating outlets", OUTLETS_SAMPLE: "Replace the sample outlets with real ones", OUTLETS_COLLECTION: "Mark at least one outlet as a collection point", SAMPLE_CONFIGURATION: "This is the sample campaign; create a real one", ENVIRONMENT: "Production activation needs a production environment" };
  if (m[f.code]) return m[f.code];
  if (f.code.startsWith("DECISION_MISSING_")) return `Register decision ${f.code.slice(17)}`;
  if (f.code.startsWith("DECISION_OPEN_")) return `Get decision ${f.code.slice(14)} approved or marked not required`;
  if (f.code.startsWith("DECISION_NO_VALUE_")) return `Record the approved value for ${f.code.slice(18)}`;
  if (f.code.startsWith("STAFF_")) return "Staffing: " + f.message;
  if (f.code.startsWith("EVIDENCE_")) return "Sign-off evidence: " + f.message;
  return titleCase(f.code.toLowerCase());
}

/* ------------------------------------------------------------------ basics */
function BasicsSection({ d }: { d: Detail }) {
  const c = d.campaign; const editable = useEditable(d); const toast = useToast(); const utils = trpc.useUtils();
  const up = trpc.campaigns.update.useMutation({ onSuccess: () => utils.campaigns.get.invalidate({ campaignId: c.id }) });
  const init = { name: c.name, description: c.description, startsAt: local(c.startsAt), endsAt: local(c.endsAt), timezone: c.timezone };
  const [f, setF] = useState(init); const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const problems = [!f.name.trim() && "A name is required.", (!f.startsAt || !f.endsAt) && "Start and end are required.", f.startsAt && f.endsAt && new Date(f.endsAt) <= new Date(f.startsAt) && "The end must be after the start."].filter(Boolean) as string[];
  const save = async () => { try { await up.mutateAsync({ campaignId: c.id, name: f.name.trim(), description: f.description, startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(), timezone: f.timezone.trim() || undefined }); toast.push("Basics saved", "success"); } catch (e) { toast.push(errorMessage(e), "error"); } };
  return <Card title="Basics">
    {c.status === "active" && <Callout tone="warning">This campaign is live. Changing its window takes effect immediately for participants; the name appears in their next message.</Callout>}
    <div className="tt-col" style={{ marginTop: 12 }}>
      <div className="form-row"><Field label="Name"><Input value={f.name} disabled={!editable} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Code" help="Fixed at creation; used in exports and the audit log."><Input mono value={c.code} readOnly disabled /></Field></div>
      <Field label="Description" help="For the team, not for participants."><Textarea value={f.description} disabled={!editable} maxLength={2000} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <div className="form-row"><Field label="Starts"><Input type="datetime-local" value={f.startsAt} disabled={!editable} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></Field><Field label="Ends"><Input type="datetime-local" value={f.endsAt} disabled={!editable} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></Field><Field label="Time zone"><Input list="tz-options" value={f.timezone} disabled={!editable} onChange={(e) => setF({ ...f, timezone: e.target.value })} /><datalist id="tz-options">{timezoneOptions().map((z) => <option key={z} value={z} />)}</datalist></Field></div>
      <KV rows={[["Status", <><Badge status={c.status} /> <span className="small muted">changed from the button at the top of the page; {whoCan("campaign.activate")} only</span></>], ["Participant-facing name", <span className="muted">the name above, in the WhatsApp welcome ({"{campaign}"})</span>]]} />
    </div>
    <SaveBar dirty={dirty} saving={up.isPending} onSave={save} onDiscard={() => setF(init)} problems={problems} editable={editable} next={`/campaigns/${c.id}?s=products`} />
  </Card>;
}

/* ------------------------------------------------------------------ products & qualification */
function ProductsSection({ d, w, next }: { d: Detail; w: Working; next: string }) {
  const editable = useEditable(d); const { save, saving } = useSaveVersion(d, w);
  const master = trpc.masterData.products.useQuery();
  const [r, setR] = useState<RulesT>(w.rules); const dirty = JSON.stringify(r) !== JSON.stringify(w.rules);
  const q = r.qualification; const setQ = (p: Partial<RulesT["qualification"]>) => setR({ ...r, qualification: { ...q, ...p } });
  const setP = (i: number, p: Partial<RulesT["products"][number]>) => setR({ ...r, products: r.products.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const problems = [r.products.some((p) => !p.code.trim() || !p.name.trim()) && "Every product needs a code and a name.", r.products.some((p) => !(p.packGrams > 0)) && "Pack size must be a positive number of grams.", new Set(r.products.map((p) => p.code)).size !== r.products.length && "Product codes must be unique.", !r.products.some((p) => p.qualifying) && "At least one product must qualify for the promotion to accept any receipt.", q.mode === "packs" && !(q.minPacks > 0) && "Minimum packs must be at least 1.", !(q.minTotalGrams > 0) && "Minimum total grams must be positive."].filter(Boolean) as string[];
  const unused = (master.data ?? []).filter((m) => m.active && !r.products.some((p) => p.code === m.sku));
  return <Card title="Products & qualification">
    <VersionNote d={d} w={w} />
    <p className="small muted">A receipt qualifies when the qualifying products on it add up to the threshold below. Products are read off the receipt by name and aliases, so list every way a till prints them.</p>
    <h3 style={{ margin: "12px 0 8px" }}>Qualifying products</h3>
    <div className="setup-rows">
      {r.products.map((p, i) => <div key={i} className="setup-row">
        <Field label="Code"><Input mono value={p.code} disabled={!editable} onChange={(e) => setP(i, { code: e.target.value })} /></Field>
        <Field label="Name as printed"><Input value={p.name} disabled={!editable} onChange={(e) => setP(i, { name: e.target.value })} /></Field>
        <Field label="Pack (g)"><Input type="number" min={1} value={p.packGrams} disabled={!editable} onChange={(e) => setP(i, { packGrams: num(e.target.value) ?? 0 })} /></Field>
        <Field label="Other spellings, comma-separated"><Input value={p.aliases.join(", ")} disabled={!editable} onChange={(e) => setP(i, { aliases: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></Field>
        <Checkbox label="Qualifies" checked={p.qualifying} disabled={!editable} onChange={(e) => setP(i, { qualifying: e.target.checked })} />
        <Button size="sm" variant="ghost" disabled={!editable} onClick={() => setR({ ...r, products: r.products.filter((_, j) => j !== i) })} aria-label={`Remove ${p.name || "product"}`}>Remove</Button>
      </div>)}
      {r.products.length === 0 && <p className="muted small">No products yet.</p>}
    </div>
    {editable && <div className="tt-row" style={{ marginTop: 8 }}>
      {unused.length > 0 && <Select value="" style={{ width: "auto" }} aria-label="Add a product from master data" onChange={(e) => { const m = unused.find((x) => x.sku === e.target.value); if (m) setR({ ...r, products: [...r.products, { code: m.sku, name: m.name, packGrams: m.packGrams, aliases: m.aliases, qualifying: true }] }); }}><option value="">Add from master data…</option>{unused.map((m) => <option key={m.sku} value={m.sku}>{m.name} · {m.packGrams} g</option>)}</Select>}
      <Button size="sm" onClick={() => setR({ ...r, products: [...r.products, { code: "", name: "", packGrams: 2000, aliases: [], qualifying: true }] })}>Add a product</Button>
      <Link to="/master-data" className="small">Master data</Link>
    </div>}
    <h3 style={{ margin: "20px 0 8px" }}>What counts as a qualifying purchase</h3>
    <div className="form-row">
      <Field label="Count by"><Select value={q.mode} disabled={!editable} onChange={(e) => setQ({ mode: e.target.value as "packs" | "weight" })}><option value="packs">Packs of a given size</option><option value="weight">Total weight</option></Select></Field>
      {q.mode === "packs" && <><Field label="Minimum packs"><Input type="number" min={1} value={q.minPacks} disabled={!editable} onChange={(e) => setQ({ minPacks: num(e.target.value) ?? 1 })} /></Field><Field label="Pack size (g)"><Input type="number" min={1} value={q.packGrams} disabled={!editable} onChange={(e) => setQ({ packGrams: num(e.target.value) ?? 1 })} /></Field></>}
      <Field label="Minimum total (g)" help={q.mode === "packs" ? "Also enforced; normally packs × pack size." : "The total grams of qualifying products on one receipt."}><Input type="number" min={1} value={q.minTotalGrams} disabled={!editable} onChange={(e) => setQ({ minTotalGrams: num(e.target.value) ?? 1 })} /></Field>
      <Field label="Entries per qualifying receipt"><Input type="number" min={1} value={r.award.unitsPerReceipt} disabled={!editable} onChange={(e) => setR({ ...r, award: { unitsPerReceipt: num(e.target.value) ?? 1 } })} /></Field>
    </div>
    <div style={{ marginTop: 8 }}><Checkbox label="Different pack sizes may be combined to reach the minimum" checked={q.allowMixedPacks} disabled={!editable} onChange={(e) => setQ({ allowMixedPacks: e.target.checked })} /></div>
    <SaveBar dirty={dirty} saving={saving} onSave={() => void save({ rules: r })} onDiscard={() => setR(w.rules)} problems={problems} editable={editable} next={next} />
  </Card>;
}

/* ------------------------------------------------------------------ entry rules */
function RulesSection({ d, w, next }: { d: Detail; w: Working; next: string }) {
  const editable = useEditable(d); const { save, saving } = useSaveVersion(d, w);
  const [r, setR] = useState<RulesT>(w.rules); const dirty = JSON.stringify(r) !== JSON.stringify(w.rules);
  const pw = r.purchaseWindow;
  const problems = [pw && Date.parse(pw.end) <= Date.parse(pw.start) && "The purchase window must end after it starts.", r.eligibility.minAge < 0 && "Minimum age cannot be negative."].filter(Boolean) as string[];
  return <Card title="Entry rules">
    <VersionNote d={d} w={w} />
    <h3 style={{ margin: "12px 0 8px" }}>Entry limits</h3>
    <div className="form-row">
      <Field label="Entries per participant per period" help="Blank means no limit."><Input type="number" min={1} value={r.caps.perParticipantPerPeriod ?? ""} disabled={!editable} onChange={(e) => setR({ ...r, caps: { ...r.caps, perParticipantPerPeriod: num(e.target.value) } })} /></Field>
      <Field label="Entries per participant for the whole campaign" help="Blank means no limit."><Input type="number" min={1} value={r.caps.perParticipantCampaign ?? ""} disabled={!editable} onChange={(e) => setR({ ...r, caps: { ...r.caps, perParticipantCampaign: num(e.target.value) } })} /></Field>
    </div>
    <h3 style={{ margin: "20px 0 8px" }}>Eligibility</h3>
    <div className="form-row">
      <Field label="Minimum age" help="Stated in the terms message participants accept."><Input type="number" min={0} value={r.eligibility.minAge} disabled={!editable} onChange={(e) => setR({ ...r, eligibility: { ...r.eligibility, minAge: num(e.target.value) ?? 18 } })} /></Field>
      <Field label="Previous winners"><Select value={r.eligibility.priorWinnerExclusion} disabled={!editable} onChange={(e) => setR({ ...r, eligibility: { ...r.eligibility, priorWinnerExclusion: e.target.value as "none" | "campaign" } })}><option value="none">May win again</option><option value="campaign">Excluded from later draws in this campaign</option></Select></Field>
    </div>
    <h3 style={{ margin: "20px 0 8px" }}>Purchase dates</h3>
    <Checkbox label="Only accept receipts dated within a window (otherwise the campaign window applies)" checked={!!pw} disabled={!editable} onChange={(e) => setR({ ...r, purchaseWindow: e.target.checked ? { start: d.campaign.startsAt, end: d.campaign.endsAt } : null })} />
    {pw && <div className="form-row" style={{ marginTop: 8 }}><Field label="Receipts dated from"><Input type="datetime-local" value={local(pw.start)} disabled={!editable} onChange={(e) => setR({ ...r, purchaseWindow: { ...pw, start: new Date(e.target.value).toISOString() } })} /></Field><Field label="Receipts dated until"><Input type="datetime-local" value={local(pw.end)} disabled={!editable} onChange={(e) => setR({ ...r, purchaseWindow: { ...pw, end: new Date(e.target.value).toISOString() } })} /></Field></div>}
    <h3 style={{ margin: "20px 0 8px" }}>Automatic checks</h3>
    <p className="small muted">Thresholds for the receipt reader. A receipt that falls below them is not rejected; it goes to a reviewer.</p>
    <div className="form-row">
      <Field label="Outlet must match a participating outlet"><Select value={r.outletMatch.required ? "yes" : "no"} disabled={!editable} onChange={(e) => setR({ ...r, outletMatch: { ...r.outletMatch, required: e.target.value === "yes" } })}><option value="yes">Required</option><option value="no">Not required</option></Select></Field>
      <Field label="Minimum outlet match score (0–1)"><Input type="number" min={0} max={1} step={0.05} value={r.outletMatch.minScore} disabled={!editable} onChange={(e) => setR({ ...r, outletMatch: { ...r.outletMatch, minScore: num(e.target.value, false) ?? 0.5 } })} /></Field>
      <Field label="Minimum 'looks like a receipt' score (0–1)"><Input type="number" min={0} max={1} step={0.05} value={r.review.minDocumentScore} disabled={!editable} onChange={(e) => setR({ ...r, review: { ...r.review, minDocumentScore: num(e.target.value, false) ?? 0.5 } })} /></Field>
      <Field label="Minimum text confidence (0–1)"><Input type="number" min={0} max={1} step={0.05} value={r.review.minOcrConfidence} disabled={!editable} onChange={(e) => setR({ ...r, review: { ...r.review, minOcrConfidence: num(e.target.value, false) ?? 0.3 } })} /></Field>
    </div>
    <SaveBar dirty={dirty} saving={saving} onSave={() => void save({ rules: r })} onDiscard={() => setR(w.rules)} problems={problems} editable={editable} next={next} />
  </Card>;
}

/* ------------------------------------------------------------------ registration & receipts */
function RegistrationSection({ d, w, next }: { d: Detail; w: Working; next: string }) {
  const editable = useEditable(d); const { save, saving } = useSaveVersion(d, w);
  const [f, setF] = useState<FlagsT>(w.flags); const [dateOrder, setDateOrder] = useState<RulesT["dateOrder"]>(w.rules.dateOrder);
  const dirty = JSON.stringify(f) !== JSON.stringify(w.flags) || dateOrder !== w.rules.dateOrder;
  return <Card title="Registration & receipts">
    <VersionNote d={d} w={w} />
    <h3 style={{ margin: "12px 0 8px" }}>What a participant provides at registration</h3>
    <p className="small muted">First name, surname and WhatsApp number are always collected; the terms are always accepted before the first entry. The rest is configurable.</p>
    <div className="form-row">
      <Field label="National ID number" help="Needed to verify a winner. Asking later means fewer drop-offs at registration but a verification step on winning."><Select value={f.identityStage} disabled={!editable} onChange={(e) => setF({ ...f, identityStage: e.target.value as FlagsT["identityStage"] })}><option value="registration">Ask at registration</option><option value="winner">Ask only when someone wins</option><option value="off">Never ask</option></Select></Field>
      <Field label="Location" help="What the participant is asked for, and what the entries can be filtered by."><Select value={f.locationMode} disabled={!editable} onChange={(e) => setF({ ...f, locationMode: e.target.value as FlagsT["locationMode"] })}><option value="town">Town or city</option><option value="province">Province</option><option value="outlet">Nearest participating outlet</option></Select></Field>
    </div>
    <div style={{ marginTop: 8 }}><Checkbox label='Participants can ask for their own entries ("My entries" on the menu)' checked={f.participantStatus} disabled={!editable} onChange={(e) => setF({ ...f, participantStatus: e.target.checked })} /></div>
    <h3 style={{ margin: "20px 0 8px" }}>Receipts</h3>
    <div className="form-row">
      <Field label="How the tills print dates" help="Used to read the purchase date off the receipt."><Select value={dateOrder} disabled={!editable} onChange={(e) => setDateOrder(e.target.value as RulesT["dateOrder"])}><option value="DMY">Day / month / year</option><option value="MDY">Month / day / year</option></Select></Field>
    </div>
    <KV rows={[["Always required", "One clear photo of the whole receipt: shop name, date, receipt number and the qualifying line readable. Voice notes, stickers and text are refused."], ["Participant instructions", <>The wording the participant sees (<span className="mono">outlet_confirmed</span>, <span className="mono">need_photo</span>, <span className="mono">received</span>) is edited under <Link to={`/campaigns/${d.campaign.id}?s=content`}>Terms &amp; messages</Link>.</>], ["Re-use", "A receipt that was already credited — by anyone — is refused as a duplicate."]]} />
    <SaveBar dirty={dirty} saving={saving} onSave={() => void save({ flags: f, rules: { ...w.rules, dateOrder } })} onDiscard={() => { setF(w.flags); setDateOrder(w.rules.dateOrder); }} editable={editable} next={next} />
  </Card>;
}

/* ------------------------------------------------------------------ terms & messages */
const MESSAGE_KEYS = Object.keys(MESSAGES).sort();
function ContentSection({ d, w, next }: { d: Detail; w: Working; next: string }) {
  const editable = useEditable(d); const { save, saving } = useSaveVersion(d, w);
  const [c, setC] = useState<ContentT>(w.content); const dirty = JSON.stringify(c) !== JSON.stringify(w.content);
  const overrides = Object.entries(c.messages); const [addKey, setAddKey] = useState("");
  const setMsg = (k: string, v: string) => setC({ ...c, messages: { ...c.messages, [k]: v } });
  const delMsg = (k: string) => { const m = { ...c.messages }; delete m[k]; setC({ ...c, messages: m }); };
  const problems = [c.termsUrl && !/^https?:\/\//.test(c.termsUrl) && "The terms link must start with http:// or https://.", c.prizeArtworkUrl && !/^https?:\/\//.test(c.prizeArtworkUrl) && "The artwork link must start with http:// or https://."].filter(Boolean) as string[];
  return <Card title="Terms & messages">
    <VersionNote d={d} w={w} />
    <h3 style={{ margin: "12px 0 8px" }}>Terms and privacy</h3>
    <div className="form-row">
      <Field label="Terms version" help="Quoted in the acceptance message and recorded against each registration."><Input value={c.termsVersion} disabled={!editable} onChange={(e) => setC({ ...c, termsVersion: e.target.value })} placeholder="e.g. T&C v2 (12 Oct 2026)" /></Field>
      <Field label="Privacy notice version"><Input value={c.privacyVersion} disabled={!editable} onChange={(e) => setC({ ...c, privacyVersion: e.target.value })} /></Field>
    </div>
    <Field label="Link to the full terms" help="Sent to participants; must be a public page."><Input value={c.termsUrl} disabled={!editable} onChange={(e) => setC({ ...c, termsUrl: e.target.value })} placeholder="https://…" /></Field>
    <h3 style={{ margin: "20px 0 8px" }}>Prizes as participants see them</h3>
    <Field label="Prizes text" help="Menu option 5. Plain text; keep it to what is approved."><Textarea value={c.prizesText} disabled={!editable} onChange={(e) => setC({ ...c, prizesText: e.target.value })} /></Field>
    <div className="form-row" style={{ marginTop: 12 }}>
      <Field label="Prize artwork (image link)" help="Optional. Sent with the prizes text when set."><Input value={c.prizeArtworkUrl} disabled={!editable} onChange={(e) => setC({ ...c, prizeArtworkUrl: e.target.value })} placeholder="https://…" /></Field>
      <Field label="Artwork description" help="What the image shows, for anyone who cannot see it."><Input value={c.prizeArtworkAlt} disabled={!editable} onChange={(e) => setC({ ...c, prizeArtworkAlt: e.target.value })} /></Field>
      <Field label="Approved winner message template" help="The WhatsApp template name winners are notified with; production activation needs it."><Input mono value={c.winnerTemplateName} disabled={!editable} onChange={(e) => setC({ ...c, winnerTemplateName: e.target.value })} /></Field>
    </div>
    <h3 style={{ margin: "20px 0 8px" }}>Participant-facing wording</h3>
    <p className="small muted">Every message has a default. Override only the ones this campaign needs to say differently; placeholders in braces such as <span className="mono">{"{reference}"}</span> are filled in when the message is sent and must be kept.</p>
    <div className="setup-rows">
      {overrides.map(([k, v]) => <div key={k} className="setup-row msg">
        <div><div className="mono small strong">{k}</div><div className="small muted" style={{ whiteSpace: "pre-wrap" }}>Default: {MESSAGES[k] ?? "(no default: custom key)"}</div></div>
        <Textarea value={v} disabled={!editable} onChange={(e) => setMsg(k, e.target.value)} style={{ minHeight: 64 }} />
        <Button size="sm" variant="ghost" disabled={!editable} onClick={() => delMsg(k)}>Remove</Button>
      </div>)}
      {overrides.length === 0 && <p className="muted small">No overrides: every message uses its default.</p>}
    </div>
    {editable && <div className="tt-row" style={{ marginTop: 8 }}><Select value={addKey} style={{ width: "auto" }} aria-label="Message to override" onChange={(e) => setAddKey(e.target.value)}><option value="">Choose a message to override…</option>{MESSAGE_KEYS.filter((k) => !(k in c.messages)).map((k) => <option key={k} value={k}>{k}</option>)}</Select><Button size="sm" disabled={!addKey} onClick={() => { setMsg(addKey, MESSAGES[addKey] ?? ""); setAddKey(""); }}>Add override</Button></div>}
    <SaveBar dirty={dirty} saving={saving} onSave={() => void save({ content: c })} onDiscard={() => setC(w.content)} problems={problems} editable={editable} next={next} />
  </Card>;
}

/* ------------------------------------------------------------------ prizes & draws */
function PrizesSection({ d, w, next }: { d: Detail; w: Working; next: string }) {
  const editable = useEditable(d); const { save, saving, refresh } = useSaveVersion(d, w); const can = useCan(); const toast = useToast();
  const [p, setP] = useState<PrizePlanT>(w.plan); const dirty = JSON.stringify(p) !== JSON.stringify(w.plan);
  const setT = (i: number, t: Partial<PrizePlanT["tiers"][number]>) => setP({ ...p, tiers: p.tiers.map((x, j) => (j === i ? { ...x, ...t } : x)) });
  const problems = [p.tiers.some((t) => !t.code.trim() || !t.label.trim()) && "Every prize tier needs a code and a label.", p.tiers.some((t) => !(t.count > 0)) && "Each tier needs at least one prize.", new Set(p.tiers.map((t) => t.code)).size !== p.tiers.length && "Tier codes must be unique.", !(p.claimDays > 0) && "Claim days must be at least 1."].filter(Boolean) as string[];
  const up = trpc.campaigns.upsertPeriod.useMutation({ onSuccess: () => void refresh() });
  const [edit, setEdit] = useState<null | { code: string; label: string; startsAt: string; endsAt: string; drawAt: string; prizePlan: string; isNew: boolean }>(null);
  return <div className="tt-stack">
    <Card title="Prizes">
      <VersionNote d={d} w={w} />
      <p className="small muted">The prize plan for each draw: how many of each prize are drawn, and how many stand-by winners are selected in case a winner cannot be verified. A period may override it below.</p>
      <div className="setup-rows">
        {p.tiers.map((t, i) => <div key={i} className="setup-row tiers">
          <Field label="Code"><Input mono value={t.code} disabled={!editable} onChange={(e) => setT(i, { code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Prize"><Input value={t.label} disabled={!editable} onChange={(e) => setT(i, { label: e.target.value })} placeholder="e.g. USD 200 grocery voucher" /></Field>
          <Field label="How many"><Input type="number" min={1} value={t.count} disabled={!editable} onChange={(e) => setT(i, { count: num(e.target.value) ?? 1 })} /></Field>
          <Button size="sm" variant="ghost" disabled={!editable} onClick={() => setP({ ...p, tiers: p.tiers.filter((_, j) => j !== i) })}>Remove</Button>
        </div>)}
        {p.tiers.length === 0 && <p className="muted small">No prize tiers yet — a draw cannot run without one.</p>}
      </div>
      {editable && <div style={{ marginTop: 8 }}><Button size="sm" onClick={() => setP({ ...p, tiers: [...p.tiers, { code: `P${p.tiers.length + 1}`, label: "", count: 1 }] })}>Add a prize tier</Button></div>}
      <h3 style={{ margin: "20px 0 8px" }}>Selection and collection</h3>
      <div className="form-row">
        <Field label="Stand-by winners per prize" help="Drawn in order behind each winner; used only if the winner is ineligible, unreachable or declines."><Input type="number" min={0} value={p.alternatesPerWinner} disabled={!editable} onChange={(e) => setP({ ...p, alternatesPerWinner: num(e.target.value) ?? 0 })} /></Field>
        <Field label="Days to claim" help="After notification. Unclaimed prizes pass to the next stand-by."><Input type="number" min={1} value={p.claimDays} disabled={!editable} onChange={(e) => setP({ ...p, claimDays: num(e.target.value) ?? 7 })} /></Field>
      </div>
      <div style={{ marginTop: 8 }}><Checkbox label="One prize per participant per draw" checked={p.onePrizePerParticipant} disabled={!editable} onChange={(e) => setP({ ...p, onePrizePerParticipant: e.target.checked })} /></div>
      <KV rows={[["How winners are chosen", "Every active entry in the period has one chance per entry. The draw officer freezes the entry list, executes the seeded random selection, a different person approves it after the integrity check, and fulfilment publishes it. Each step is audited; the bundle can be re-verified independently."], ["Collection", <>Winners collect from an outlet marked as a collection point under <Link to={`/campaigns/${d.campaign.id}?s=outlets`}>Participating outlets</Link>; verification and hand-over are recorded under Winners &amp; claims.</>]]} />
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save({ prizePlan: p })} onDiscard={() => setP(w.plan)} problems={problems} editable={editable} next={next} />
    </Card>
    <Card title="Draw periods" actions={can("campaign.write") ? <Button size="sm" variant="primary" onClick={() => setEdit({ code: "", label: "", startsAt: "", endsAt: "", drawAt: "", prizePlan: "", isNew: true })}>Add period</Button> : <Restricted perm="campaign.write" action="Adding a period" />}>
      <p className="small muted">Each period collects entries between its start and end and is drawn at the draw time. Periods may not overlap; a drawn period cannot be changed.</p>
      <Table rows={d.periods} keyOf={(x) => x.id} cols={[{ h: "Code", c: (x) => <span className="mono strong">{x.code}</span> }, { h: "Label", c: (x) => x.label }, { h: "Entries collected", c: (x) => `${fmtDate(x.startsAt)} → ${fmtDate(x.endsAt)}` }, { h: "Draw", c: (x) => fmtDate(x.drawAt) }, { h: "Status", c: (x) => <Badge status={x.status} /> }, { h: "Prize plan", c: (x) => x.prizePlan ? "period-specific" : "campaign plan" }, { h: "", c: (x) => can("campaign.write") && x.status !== "drawn" ? <Button size="sm" onClick={() => setEdit({ code: x.code, label: x.label, startsAt: local(x.startsAt), endsAt: local(x.endsAt), drawAt: local(x.drawAt), prizePlan: x.prizePlan ? JSON.stringify(x.prizePlan, null, 2) : "", isNew: false })}>Edit</Button> : null }]} empty="No periods yet. A draw needs at least one." />
      {edit && <Modal title={edit.isNew ? "New period" : `Period ${edit.code}`} onClose={() => setEdit(null)} foot={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={up.isPending} disabled={!edit.code || !edit.startsAt || !edit.endsAt} onClick={async () => { try { let plan: PrizePlanT | null = null; if (edit.prizePlan.trim()) { try { plan = PrizePlan.parse(JSON.parse(edit.prizePlan)); } catch { toast.push("The prize plan override is not valid", "error"); return; } } await up.mutateAsync({ campaignId: d.campaign.id, code: edit.code, label: edit.label || undefined, startsAt: new Date(edit.startsAt).toISOString(), endsAt: new Date(edit.endsAt).toISOString(), drawAt: edit.drawAt ? new Date(edit.drawAt).toISOString() : null, prizePlan: plan }); setEdit(null); toast.push("Period saved", "success"); } catch (e) { toast.push(errorMessage(e), "error"); } }}>Save</Button></>}>
        <div className="tt-col">
          <div className="form-row"><Field label="Code" help="Short and stable, e.g. W1 or DEC"><Input mono value={edit.code} disabled={!edit.isNew} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field><Field label="Label"><Input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} placeholder="Week 1" /></Field></div>
          <div className="form-row"><Field label="Entries from"><Input type="datetime-local" value={edit.startsAt} onChange={(e) => setEdit({ ...edit, startsAt: e.target.value })} /></Field><Field label="Entries until"><Input type="datetime-local" value={edit.endsAt} onChange={(e) => setEdit({ ...edit, endsAt: e.target.value })} /></Field><Field label="Draw at"><Input type="datetime-local" value={edit.drawAt} onChange={(e) => setEdit({ ...edit, drawAt: e.target.value })} /></Field></div>
          <Field label="Prize plan override (advanced, JSON, optional)" help="Leave empty to use the campaign's prize plan."><Textarea mono value={edit.prizePlan} onChange={(e) => setEdit({ ...edit, prizePlan: e.target.value })} placeholder='{"tiers":[{"code":"P1","label":"…","count":2}],"alternatesPerWinner":1,"onePrizePerParticipant":true,"claimDays":7}' /></Field>
        </div>
      </Modal>}
    </Card>
  </div>;
}

/* ------------------------------------------------------------------ outlets */
function OutletsSection({ campaignId }: { campaignId: string }) {
  const can = useCan(); const toast = useToast(); const utils = trpc.useUtils();
  const q = trpc.campaigns.outlets.useQuery({ campaignId }); const all = trpc.masterData.outlets.useQuery();
  const onChange = () => Promise.all([utils.campaigns.get.invalidate({ campaignId }), utils.campaigns.activation.invalidate({ campaignId })]);
  const setOutlets = trpc.campaigns.setOutlets.useMutation({ onSuccess: () => { q.refetch(); void onChange(); } }); const imp = trpc.campaigns.importOutlets.useMutation();
  const [csv, setCsv] = useState(""); const [preview, setPreview] = useState<unknown>(null); const [filter, setFilter] = useState(""); const [onlyIn, setOnlyIn] = useState(false);
  const members = new Map((q.data ?? []).map((o) => [o.id, o.membership]));
  const rows = (all.data ?? []).filter((o) => (!filter || `${o.code} ${o.retailer} ${o.branch} ${o.town}`.toLowerCase().includes(filter.toLowerCase())) && (!onlyIn || members.has(o.id)));
  const toggle = async (outletId: string, on: boolean, collection?: boolean) => { const next = (q.data ?? []).filter((o) => o.id !== outletId).map((o) => ({ outletId: o.id, collectionPoint: o.membership.collectionPoint })); if (on) next.push({ outletId, collectionPoint: collection ?? members.get(outletId)?.collectionPoint ?? false }); try { await setOutlets.mutateAsync({ campaignId, members: next }); } catch (e) { toast.push(errorMessage(e), "error"); } };
  const collection = (q.data ?? []).filter((o) => o.membership.collectionPoint).length;
  return <div className="tt-stack">
    <Card title={<h2>Participating outlets <span className="muted">({q.data?.length ?? 0} of {all.data?.length ?? 0} · {collection} collection point{collection === 1 ? "" : "s"})</span></h2>} actions={<><Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 200 }} aria-label="Filter outlets" /><Checkbox label="In campaign only" checked={onlyIn} onChange={(e) => setOnlyIn(e.target.checked)} /></>}>
      <p className="small muted">Receipts are accepted from these outlets only when the entry rules require an outlet match. A collection point is where a winner can collect a prize. {!can("campaign.write") && <Restricted perm="campaign.write" action="Changing the list" />}</p>
      {q.isLoading || all.isLoading ? <Loading /> : <Table rows={rows} keyOf={(o) => o.id} cols={[{ h: "In campaign", c: (o) => <input type="checkbox" checked={members.has(o.id)} disabled={!can("campaign.write")} aria-label={`${o.retailer} ${o.branch} in campaign`} onChange={(e) => toggle(o.id, e.target.checked)} /> }, { h: "Code", c: (o) => <span className="mono">{o.code}</span> }, { h: "Retailer", c: (o) => o.retailer }, { h: "Branch", c: (o) => o.branch }, { h: "Town", c: (o) => o.town }, { h: "Region", c: (o) => o.region }, { h: "Collection point", c: (o) => members.has(o.id) ? <input type="checkbox" checked={!!members.get(o.id)?.collectionPoint} disabled={!can("campaign.write")} aria-label={`${o.retailer} ${o.branch} collection point`} onChange={(e) => toggle(o.id, true, e.target.checked)} /> : (o.collectionPoint ? "default yes" : "") }, { h: "Active", c: (o) => o.active ? "yes" : <Badge tone="danger">no</Badge> }]} empty="No outlets in master data yet. Import some below, or add them under Outlets & products." />}
    </Card>
    {can("campaign.write") && <Card title="Import outlets from CSV" actions={<a className="btn sm" href="/fixtures/outlets-import-template.csv" download>Template</a>}>
      <p className="small muted">Columns: code, retailer, branch, town, region, aliases (| separated), collection_point (yes/no). Existing codes are updated; new ones created and added to this campaign. Run a dry run first.</p>
      <Textarea mono value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="code,retailer,branch,town,region,aliases,collection_point" />
      <div className="tt-row" style={{ marginTop: 8 }}><input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} /><Button loading={imp.isPending} disabled={!csv.trim()} onClick={async () => { try { setPreview(await imp.mutateAsync({ campaignId, csv, dryRun: true })); } catch (e) { toast.push(errorMessage(e), "error"); } }}>Dry run</Button><Button variant="primary" loading={imp.isPending} disabled={!csv.trim()} onClick={async () => { try { setPreview(await imp.mutateAsync({ campaignId, csv, dryRun: false })); q.refetch(); all.refetch(); void onChange(); toast.push("Import applied", "success"); } catch (e) { toast.push(errorMessage(e), "error"); } }}>Import</Button></div>
      {preview != null && <div style={{ marginTop: 12 }}><Json value={preview} /></div>}
    </Card>}
  </div>;
}

/* ------------------------------------------------------------------ team & controls */
const TEAM_ROLES: Array<{ role: string; does: string }> = [
  { role: "campaign_manager", does: "Configures and activates the campaign; sets the pause switches." },
  { role: "reviewer", does: "Decides receipts the reader could not; sees receipt images." },
  { role: "support", does: "Answers participants; corrects their details." },
  { role: "draw_officer", does: "Freezes and executes draws. Cannot approve their own." },
  { role: "draw_approver", does: "Approves or rejects an executed draw after the integrity check." },
  { role: "fulfilment", does: "Verifies winners, records prize hand-over, publishes results." },
  { role: "auditor", does: "Verifies the audit chain; exports." },
  { role: "platform_admin", does: "Accounts, settings and integrations. Reads everything; runs nothing." },
  { role: "promotion_admin", does: "The client's team: the promotion desk, can disqualify an entry." },
  { role: "promotion_assistant", does: "The client's team: the promotion desk, read and reply only." },
];
function TeamSection({ d }: { d: Detail }) {
  const can = useCan(); const toast = useToast(); const utils = trpc.useUtils(); const c = d.campaign;
  const dir = trpc.auth.directory.useQuery();
  const setControls = trpc.campaigns.setControls.useMutation({ onSuccess: () => utils.campaigns.get.invalidate({ campaignId: c.id }) });
  return <div className="tt-stack">
    <Card title="Team" actions={can("staff.manage") ? <Link to="/staff" className="btn sm">Manage accounts</Link> : <Restricted perm="staff.manage" action="Changing who holds a role" />}>
      <Callout tone="info">Roles are held on the account and apply to every campaign on this installation. There is no per-campaign membership: someone who can approve a draw can approve any campaign's draw. What each role may do is defined once, in the permission policy, and enforced by the server.</Callout>
      {dir.isLoading ? <Loading /> : dir.error ? <ErrorBox error={dir.error} /> : <Table rows={TEAM_ROLES} keyOf={(r) => r.role} cols={[{ h: "Role", c: (r) => <strong>{roleLabel(r.role)}</strong> }, { h: "People", c: (r) => { const ppl = (dir.data ?? []).filter((u) => u.roles.includes(r.role)); return ppl.length ? ppl.map((u) => <div key={u.id}>{u.name} <span className="small muted">{u.email}</span></div>) : <span className="muted">nobody</span>; } }, { h: "On this campaign", c: (r) => r.does }]} />}
    </Card>
    <Card title="Operational controls">
      <p className="small muted">Immediate, reversible switches for the running campaign. Each change is audited. {!can("campaign.write") && <Restricted perm="campaign.write" action="Changing a switch" />}</p>
      <div className="tt-col">{([["pauseIntake", "Pause intake — participants are told entries are paused"], ["pauseAutoQualify", "Pause automatic qualification — every receipt goes to a reviewer"], ["pauseOutbound", "Pause outbound messages — they queue until resumed"], ["pauseDraws", "Pause draws — freezing a period is refused"]] as const).map(([k, label]) => <Checkbox key={k} label={label} checked={d.controls[k]} disabled={!can("campaign.write")} onChange={async (e) => { try { await setControls.mutateAsync({ campaignId: c.id, [k]: e.target.checked }); toast.push("Control updated", "success"); } catch (e2) { toast.push(errorMessage(e2), "error"); } }} />)}</div>
    </Card>
  </div>;
}

/* ------------------------------------------------------------------ decisions */
function DecisionsSection({ campaignId, decisions }: { campaignId: string; decisions: Detail["decisions"] }) {
  const can = useCan(); const toast = useToast(); const utils = trpc.useUtils();
  const up = trpc.campaigns.upsertDecision.useMutation({ onSuccess: () => Promise.all([utils.campaigns.get.invalidate({ campaignId }), utils.campaigns.activation.invalidate({ campaignId })]) });
  const ids = trpc.campaigns.decisionIds.useQuery();
  const [edit, setEdit] = useState<Detail["decisions"][number] | null>(null);
  const open = decisions.filter((x) => x.blocksActivation && !["approved", "not_required"].includes(x.status)).length;
  const missing = (ids.data ?? []).filter((id) => !decisions.some((x) => x.decisionId === id));
  return <Card title={<h2>Client decisions <span className="muted">({open} open)</span></h2>} actions={!can("campaign.write") && <Restricted perm="campaign.write" action="Recording a decision" />}>
    <p className="small muted">The questions the client answers before launch. Test values are placeholders; production activation needs every blocking decision approved, with its value and evidence, or marked not required.</p>
    <Table rows={decisions} keyOf={(x) => x.decisionId} cols={[{ h: "ID", c: (x) => <span className="mono">{x.decisionId}</span> }, { h: "Question", c: (x) => x.question }, { h: "Test value", c: (x) => <span className="small">{x.testValue}</span> }, { h: "Approved value", c: (x) => x.approvedValue ?? <span className="muted">–</span> }, { h: "Status", c: (x) => <Badge status={x.status} tone={x.status === "approved" || x.status === "not_required" ? "success" : "warning"}>{titleCase(x.status)}</Badge> }, { h: "Blocks", c: (x) => x.blocksActivation ? "yes" : "no" }, { h: "", c: (x) => can("campaign.write") ? <Button size="sm" onClick={() => setEdit(x)}>Update</Button> : null }]} empty="No decisions registered yet." />
    {missing.length > 0 && can("campaign.write") && <div className="tt-row" style={{ marginTop: 12 }}><span className="small muted">{missing.length} standard decision{missing.length === 1 ? " is" : "s are"} not in this campaign's register.</span><Button size="sm" onClick={async () => { try { for (const id of missing) await up.mutateAsync({ campaignId, decisionId: id, status: "open", blocksActivation: true }); toast.push("Register completed", "success"); } catch (e) { toast.push(errorMessage(e), "error"); } }}>Add them</Button></div>}
    {edit && <Modal title={`${edit.decisionId}: ${edit.question}`} onClose={() => setEdit(null)} foot={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={up.isPending} onClick={async () => { try { await up.mutateAsync({ campaignId, decisionId: edit.decisionId, question: edit.question, approvedValue: edit.approvedValue, status: edit.status, owner: edit.owner, evidence: edit.evidence, blocksActivation: edit.blocksActivation }); setEdit(null); toast.push("Decision recorded", "success"); } catch (e) { toast.push(errorMessage(e), "error"); } }}>Save</Button></>}>
      <div className="tt-col"><Field label="Question"><Input value={edit.question} onChange={(e) => setEdit({ ...edit, question: e.target.value })} /></Field><Field label="Approved value"><Textarea value={edit.approvedValue ?? ""} onChange={(e) => setEdit({ ...edit, approvedValue: e.target.value })} /></Field><div className="form-row"><Field label="Status"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{["open", "proposed", "approved", "not_required"].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select></Field><Field label="Owner"><Input value={edit.owner ?? ""} onChange={(e) => setEdit({ ...edit, owner: e.target.value })} /></Field></div><Field label="Evidence (link or reference to the sign-off)"><Input value={edit.evidence ?? ""} onChange={(e) => setEdit({ ...edit, evidence: e.target.value })} /></Field><Checkbox label="Blocks production activation" checked={edit.blocksActivation} onChange={(e) => setEdit({ ...edit, blocksActivation: e.target.checked })} /></div>
    </Modal>}
  </Card>;
}

/* ------------------------------------------------------------------ readiness & activation */
function ReadinessSection({ d, w, failures, loading, refetch, go }: { d: Detail; w: Working; failures: Array<{ code: string; message: string; blocking: boolean }>; loading: boolean; refetch: () => void; go: (s: SectionId) => string }) {
  const can = useCan(); const toast = useToast(); const utils = trpc.useUtils(); const c = d.campaign;
  const refresh = () => Promise.all([utils.campaigns.get.invalidate({ campaignId: c.id }), utils.campaigns.activation.invalidate({ campaignId: c.id })]);
  const activate = trpc.campaigns.activateVersion.useMutation({ onSuccess: refresh }); const setStatus = trpc.campaigns.setStatus.useMutation({ onSuccess: refresh });
  const [confirm, setConfirm] = useState<null | "version" | "live">(null);
  const config = failures.filter((f) => !PLATFORM_CODES.test(f.code)); const platform = failures.filter((f) => PLATFORM_CODES.test(f.code));
  const configOk = config.filter((f) => f.blocking).length === 0;
  const canGoLive = ["draft", "paused"].includes(c.status) && !!d.activeVersion;
  const checks = useMemo(() => {
    const ok = (code: RegExp) => !failures.some((f) => code.test(f.code));
    return [
      { label: "At least one qualifying product", ok: ok(/^RULES_PRODUCTS/), s: "products" as SectionId },
      { label: "Terms version and link", ok: ok(/^CONTENT_TERMS/), s: "content" as SectionId },
      { label: "Prizes described for participants", ok: ok(/^CONTENT_PRIZES/), s: "content" as SectionId },
      { label: "Prize tiers", ok: ok(/^PRIZES_EMPTY/), s: "prizes" as SectionId },
      { label: "Draw periods", ok: ok(/^PERIODS_EMPTY/), s: "prizes" as SectionId },
      { label: "Participating outlets, with a collection point", ok: ok(/^OUTLETS_/), s: "outlets" as SectionId },
      { label: "Client decisions approved or not required", ok: ok(/^DECISION_/), s: "decisions" as SectionId },
      { label: "A configuration version activated", ok: !!d.activeVersion, s: "readiness" as SectionId },
    ];
  }, [failures, d.activeVersion]);
  return <div className="tt-stack">
    <Card title="Campaign configuration" actions={<Button size="sm" onClick={refetch}>Re-check</Button>}>
      {loading ? <Loading /> : <div className="check-list">{checks.map((x) => <div key={x.label} className="check-item"><span className={`mark ${x.ok ? "ok" : "no"}`}>{x.ok ? "✓" : "!"}</span><div className="what">{x.label}{!x.ok && <small>{summarise(config.filter((f) => sectionFor(f.code) === x.s).map(explain))}</small>}</div>{!x.ok && x.s !== "readiness" && <Link to={go(x.s)} className="btn sm">Fix</Link>}</div>)}</div>}
    </Card>
    <Card title="Activation">
      <VersionNote d={d} w={w} />
      <div className="check-list" style={{ marginTop: 12 }}>
        <div className="check-item"><span className={`mark ${d.activeVersion ? "ok" : "info"}`}>1</span><div className="what">Activate the configuration{w.draft ? ` — draft v${w.draft.versionNo} is waiting` : d.activeVersion ? ` — v${d.activeVersion.versionNo} is live` : ""}<small>Makes the draft the version new receipts are judged under. Receipts already decided keep theirs.</small></div>
          {w.draft ? (can("campaign.write") ? <Button variant="primary" size="sm" disabled={!w.rules.products.some((p) => p.qualifying)} title={!w.rules.products.some((p) => p.qualifying) ? "Add a qualifying product first" : undefined} onClick={() => setConfirm("version")}>Activate v{w.draft.versionNo}</Button> : <Restricted perm="campaign.write" action="Activating a version" />) : null}</div>
        <div className="check-item"><span className={`mark ${c.status === "active" ? "ok" : "info"}`}>2</span><div className="what">Set the campaign live{c.status === "active" ? " — it is live" : ""}<small>{c.status === "draft" ? "Participants can then register and enter. In production the validator below must pass first." : c.status === "paused" ? "Resumes intake." : c.status === "active" ? "Pause or close from the button at the top of the page." : `The campaign is ${c.status}.`}</small></div>
          {canGoLive ? (can("campaign.activate") ? <Button variant="primary" size="sm" onClick={() => setConfirm("live")}>{c.status === "paused" ? "Resume" : "Go live"}</Button> : <Restricted perm="campaign.activate" action="Setting the campaign live" />) : null}</div>
      </div>
      {!configOk && c.status === "draft" && <Callout tone="warning">The configuration list above is not complete. Outside production the campaign can still be set live for testing; in production activation is refused until every blocking item passes.</Callout>}
    </Card>
    <Card title={<h2>Installation and sign-off checks <span className="muted">({platform.filter((f) => f.blocking).length} blocking)</span></h2>}>
      <p className="small muted">About the deployment rather than this campaign: providers, keys, staffing and the evidence the launch needs. A platform administrator resolves these under <Link to="/readiness">Readiness</Link>, Access and the environment configuration. Only a production database is blocked by them.</p>
      <Table rows={platform} keyOf={(f) => f.code} cols={[{ h: "Code", c: (f) => <span className="mono">{f.code}</span> }, { h: "Finding", c: (f) => f.message }, { h: "Blocks", c: (f) => f.blocking ? <Badge tone="danger">yes</Badge> : <Badge>advisory</Badge> }]} empty="Nothing would block activation." />
    </Card>
    {confirm === "version" && w.draft && <ActionDialog title={`Activate configuration v${w.draft.versionNo}`} description={d.activeVersion ? `v${d.activeVersion.versionNo} is retired and v${w.draft.versionNo} takes over for every new receipt and conversation.` : "This becomes the configuration participants are judged under once the campaign is live."} confirmLabel="Activate" onConfirm={async () => { await activate.mutateAsync({ campaignId: c.id, versionId: w.draft!.id }); toast.push(`v${w.draft!.versionNo} activated`, "success"); }} onClose={() => setConfirm(null)} />}
    {confirm === "live" && <ActionDialog title={c.status === "paused" ? "Resume the campaign" : "Set the campaign live"} description="Participants can register and enter from this moment. The change is recorded in the audit log under your name." fields={[{ key: "reason", label: "Reason", type: "textarea" }]} confirmLabel={c.status === "paused" ? "Resume" : "Go live"} onConfirm={async () => { await setStatus.mutateAsync({ campaignId: c.id, status: "active" }); toast.push("The campaign is live", "success"); }} onClose={() => setConfirm(null)} />}
  </div>;
}

import { useState } from "react";
import { trpc, errorMessage, downloadAuth } from "../lib/trpc.ts";
import { useCan } from "../lib/auth.tsx";
import { PageHead, Card, Table, Badge, Button, Loading, ErrorBox, Tabs, KV, Select, Json, Input, Callout, useToast, Stat, Checkbox, ActionDialog } from "../ui/kit.tsx";
import { LineChart, AvailabilityStrip } from "../ui/charts.tsx";
import { Link, useQueryParams, navigate } from "../lib/router.tsx";
import { fmtDate, titleCase, ago } from "../lib/format.ts";
type Tab = "health" | "history" | "errors" | "queues" | "outbound" | "crm" | "alerts" | "exports" | "settings";
const TABS: Tab[] = ["health", "history", "errors", "queues", "outbound", "crm", "alerts", "exports", "settings"];
export function OpsPage() {
  const qp = useQueryParams(); const fromUrl = qp.get("tab"); const [tab, setTabState] = useState<Tab>(TABS.includes(fromUrl as Tab) ? (fromUrl as Tab) : "health"); const can = useCan();
  const setTab = (t: Tab) => { setTabState(t); navigate(t === "health" ? "/ops" : `/ops?tab=${t}`, { replace: true }); };
  return <>
    <PageHead title="Integrations & queues" sub="Uptime, throughput, failures and queues; provider modes are stated honestly and simulated or unconfigured providers are labelled." />
    <Tabs tabs={[{ id: "health", label: "Health" }, { id: "history", label: "Uptime & throughput" }, { id: "errors", label: "Error log" }, { id: "queues", label: "Queues & dead letters" }, { id: "outbound", label: "Outbound messages" }, { id: "crm", label: "CRM sync" }, { id: "alerts", label: "Alerts" }, { id: "exports", label: "Exports" }, ...(can("settings.write") || can("evidence.record") ? [{ id: "settings" as Tab, label: "Settings & evidence" }] : [])]} value={tab} onChange={setTab} />
    {tab === "health" && <Health />}{tab === "history" && <History />}{tab === "errors" && <Errors />}{tab === "queues" && <Queues />}{tab === "outbound" && <Outbound />}{tab === "crm" && <Crm />}{tab === "alerts" && <Alerts />}{tab === "exports" && <Exports />}{tab === "settings" && <Settings />}
  </>;
}
function Health() {
  const q = trpc.ops.integrations.useQuery(undefined, { refetchInterval: 15_000 }); const m = trpc.ops.metrics.useQuery({ sinceHours: 24 });
  if (q.isLoading) return <Loading />; if (q.error) return <ErrorBox error={q.error} />; const d = q.data!;
  const mode = (x: { mode?: string; ok?: boolean }) => <Badge tone={x.ok === false ? "danger" : x.mode === "configured" || x.mode === "real" ? "success" : "warning"}>{x.mode ?? (x.ok ? "ok" : "not ok")}</Badge>;
  return <div className="tt-stack"><div className="tt-grid c3">
    <Card title="WhatsApp transport"><KV rows={[["Provider", d.transport.provider], ["Mode", mode(d.transport)], ["Note", (d.transport as { note?: string }).note ?? "–"], ["Outbound allowlist", d.outboundAllowlist.length ? d.outboundAllowlist.join(", ") : "none (non-production sends go to every recipient the simulator accepts)"]]} /></Card>
    <Card title="Receipt extractor"><KV rows={[["Provider", d.extractor.provider], ["Mode", mode(d.extractor)], ["Model", d.extractor.model ?? "–"], ["Note", d.extractor.note ?? d.extractor.error ?? "–"]]} /></Card>
    <Card title="CRM"><KV rows={[["Provider", d.crm.provider], ["Mode", mode(d.crm)], ["Note", d.crm.note ?? d.crm.error ?? "–"], ["Queue", Object.entries(d.crmQueue.byStatus).map(([k, n]) => `${k} ${n}`).join(" · ") || "empty"]]} /></Card>
    <Card title="Storage & database"><KV rows={[["Storage", `${d.storage.ok ? "ok" : "NOT OK"} · ${(d.storage as { detail?: string }).detail ?? ""}`], ["Database", d.database.url], ["Environment", d.environment]]} /></Card>
    <Card title="Worker"><KV rows={[["Mode", d.workerMode], ["Running in this process", d.worker.running ? "yes" : "no"], ["Ticks", d.worker.ticks], ["Last tick", ago(d.worker.lastTickAt)]]} /></Card>
    <Card title="Queues"><KV rows={[["Inbound events", Object.entries(d.queues.events).map(([k, n]) => `${k} ${n}`).join(" · ") || "empty"], ["Jobs", Object.entries(d.queues.jobs).map(([k, n]) => `${k} ${n}`).join(" · ") || "empty"], ["Oldest waiting event", ago(d.queues.oldestEvent)], ["Outbound", Object.entries(d.outbound.byStatus).map(([k, n]) => `${k} ${n}`).join(" · ") || "empty"]]} /></Card>
  </div>
  <Card title="Metrics, last 24 hours">{m.data && <Table rows={m.data} keyOf={(r) => r.name} cols={[{ h: "Metric", c: (r) => <span className="mono">{r.name}</span> }, { h: "Events", c: (r) => r.n, num: true }, { h: "Sum", c: (r) => r.sum, num: true }]} empty="No metrics recorded yet." />}</Card></div>;
}
function Queues() {
  const q = trpc.ops.queues.useQuery(undefined, { refetchInterval: 15_000 }); const can = useCan(); const toast = useToast(); const replay = trpc.ops.replayEvent.useMutation({ onSuccess: () => q.refetch() }); const retry = trpc.ops.retryJob.useMutation({ onSuccess: () => q.refetch() });
  if (q.isLoading) return <Loading />; if (q.error) return <ErrorBox error={q.error} />; const d = q.data!;
  return <div className="tt-stack">
    <div className="tt-grid c2"><Card title="Inbound events"><KV rows={Object.entries(d.stats.events).map(([k, n]) => [titleCase(k), n])} /><p className="small muted">Oldest waiting: {ago(d.stats.oldestEvent)}</p></Card><Card title="Jobs"><KV rows={Object.entries(d.stats.jobs).map(([k, n]) => [titleCase(k), n])} /><p className="small muted">Oldest waiting: {ago(d.stats.oldestJob)}</p></Card></div>
    <Card title="Failed / dead inbound events"><Table rows={d.events} keyOf={(e) => e.id} cols={[{ h: "Event", c: (e) => <span className="mono small">{e.id}</span> }, { h: "Kind", c: (e) => e.kind }, { h: "Status", c: (e) => <Badge status={e.status} /> }, { h: "Attempts", c: (e) => e.attempts, num: true }, { h: "Error", c: (e) => <span className="small">{e.error}</span> }, { h: "Received", c: (e) => fmtDate(e.receivedAt) }, { h: "", c: (e) => can("ops.retry") ? <Button size="sm" onClick={async () => { try { await replay.mutateAsync({ id: e.id }); toast.push("Replayed", "success"); } catch (e2) { toast.push(errorMessage(e2), "error"); } }}>Replay</Button> : null }]} empty="No failed events." /></Card>
    <Card title="Failed / dead jobs"><Table rows={d.jobs} keyOf={(j) => j.id} cols={[{ h: "Job", c: (j) => <span className="mono small">{j.id}</span> }, { h: "Kind", c: (j) => j.kind }, { h: "Status", c: (j) => <Badge status={j.status} /> }, { h: "Attempts", c: (j) => j.attempts, num: true }, { h: "Error", c: (j) => <span className="small">{j.lastError}</span> }, { h: "Created", c: (j) => fmtDate(j.createdAt) }, { h: "", c: (j) => can("ops.retry") ? <Button size="sm" onClick={async () => { try { await retry.mutateAsync({ id: j.id }); toast.push("Retried", "success"); } catch (e2) { toast.push(errorMessage(e2), "error"); } }}>Retry</Button> : null }]} empty="No failed jobs." /></Card>
  </div>;
}
function Outbound() {
  const [status, setStatus] = useState(""); const q = trpc.ops.outbound.useQuery({ status: status || undefined }, { refetchInterval: 15_000 }); const can = useCan(); const toast = useToast(); const retry = trpc.ops.retryOutbound.useMutation({ onSuccess: () => q.refetch() });
  return <Card title="Outbound messages" actions={<Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{["pending", "sent", "delivered", "read", "retryable_failure", "permanent_failure", "unknown_outcome"].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>}>
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : <Table rows={q.data ?? []} keyOf={(m) => m.id} cols={[{ h: "To", c: (m) => <span className="mono">{m.channelUid}</span> }, { h: "Purpose", c: (m) => titleCase(m.purpose) }, { h: "Kind", c: (m) => m.kind }, { h: "Status", c: (m) => <Badge status={m.status} /> }, { h: "Attempts", c: (m) => m.attempts, num: true }, { h: "Error", c: (m) => <span className="small">{m.errorCode ? `${m.errorCode}: ` : ""}{m.lastError ?? ""}</span> }, { h: "Next attempt", c: (m) => fmtDate(m.nextAttemptAt) }, { h: "Created", c: (m) => fmtDate(m.createdAt) }, { h: "", c: (m) => can("ops.retry") && ["retryable_failure", "permanent_failure", "unknown_outcome"].includes(m.status) ? <Button size="sm" onClick={async () => { try { await retry.mutateAsync({ id: m.id }); toast.push("Queued again", "success"); } catch (e) { toast.push(errorMessage(e), "error"); } }}>Retry</Button> : null }]} empty="No messages for this filter." />}
    <p className="small muted" style={{ marginTop: 8 }}>Unknown outcomes are never re-sent automatically: confirm with the provider or the participant before retrying, to avoid duplicate messages.</p>
  </Card>;
}
function Crm() {
  const [status, setStatus] = useState(""); const q = trpc.ops.crmEvents.useQuery({ status: status || undefined }, { refetchInterval: 15_000 }); const can = useCan(); const toast = useToast(); const retry = trpc.ops.retryCrm.useMutation({ onSuccess: () => q.refetch() }); const reconcile = trpc.ops.reconcileCrm.useMutation({ onSuccess: () => q.refetch() }); const [type, setType] = useState("entry"); const preview = trpc.ops.crmPreview.useQuery({ type });
  return <div className="tt-stack">
    <Card title="CRM events" actions={<><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{["pending", "sending", "delivered", "retryable_failure", "permanent_failure", "unknown_outcome", "reconciled"].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>{can("ops.retry") && <Button size="sm" loading={reconcile.isPending} onClick={async () => { try { const r = await reconcile.mutateAsync(); toast.push(`Reconciled ${r.reconciled}, requeued ${r.requeued} of ${r.checked} checked`, "success"); } catch (e) { toast.push(errorMessage(e), "error"); } }}>Reconcile with vendor</Button>}</>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : <Table rows={q.data ?? []} keyOf={(e) => e.id} cols={[{ h: "Entity", c: (e) => <><Badge>{e.entityType}</Badge> <span className="mono small">{e.entityId}</span> v{e.entityVersion}</> }, { h: "Key", c: (e) => <span className="mono small">{e.externalKey}</span> }, { h: "Status", c: (e) => <Badge status={e.status} /> }, { h: "Attempts", c: (e) => e.attempts, num: true }, { h: "Error", c: (e) => <span className="small">{e.lastError ?? ""}</span> }, { h: "Delivered", c: (e) => fmtDate(e.deliveredAt) }, { h: "", c: (e) => can("ops.retry") && ["retryable_failure", "permanent_failure", "unknown_outcome"].includes(e.status) ? <Button size="sm" onClick={async () => { try { await retry.mutateAsync({ id: e.id }); toast.push("Queued again", "success"); } catch (e2) { toast.push(errorMessage(e2), "error"); } }}>Retry</Button> : null }]} empty="No CRM events for this filter." />}
    </Card>
    <Card title="Canonical mapping preview" actions={<Select value={type} onChange={(e) => setType(e.target.value)}>{["participant", "enrollment", "submission", "entry", "winner", "claim"].map((t) => <option key={t} value={t}>{t}</option>)}</Select>}><p className="small muted">What the CRM receives for each entity type (mapping version is part of every record). Identity numbers and full phone numbers are never included.</p>{preview.data && <Json value={preview.data} />}</Card>
  </div>;
}
function Alerts() {
  const [all, setAll] = useState(false); const q = trpc.ops.alerts.useQuery({ all }, { refetchInterval: 15_000 }); const can = useCan(); const ack = trpc.ops.ackAlert.useMutation({ onSuccess: () => q.refetch() });
  return <Card title="Alerts" actions={<Button size="sm" onClick={() => setAll(!all)}>{all ? "Open only" : "Include acknowledged"}</Button>}>{q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : <Table rows={q.data ?? []} keyOf={(a) => a.id} cols={[{ h: "Severity", c: (a) => <Badge status={a.severity} /> }, { h: "Kind", c: (a) => <span className="mono">{a.kind}</span> }, { h: "Message", c: (a) => <>{a.message}{a.runbook && <div className="small muted">Runbook: {a.runbook}</div>}</> }, { h: "Raised", c: (a) => fmtDate(a.createdAt) }, { h: "Acknowledged", c: (a) => a.ackedAt ? `${fmtDate(a.ackedAt)} by ${a.ackedBy}` : "" }, { h: "", c: (a) => !a.ackedAt && can("ops.alerts.ack") ? <Button size="sm" onClick={() => ack.mutate({ id: a.id })}>Acknowledge</Button> : null }]} empty="No alerts." />}</Card>;
}
function Exports() {
  const can = useCan(); const toast = useToast(); const campaigns = trpc.campaigns.list.useQuery(); const [cid, setCid] = useState(""); const [busy, setBusy] = useState<string | null>(null);
  if (!can("report.export")) return <Callout>Exports are limited to the auditor role. Every export is watermarked with the exporting user and recorded in the audit log.</Callout>;
  return <Card title="Exports (CSV, formula-safe, watermarked)" actions={<Select value={cid} onChange={(e) => setCid(e.target.value)}><option value="">Current campaign</option>{campaigns.data?.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</Select>}>
    <div className="tt-row">{["submissions", "entries", "winners", "participants", "outlets"].map((s) => <Button key={s} loading={busy === s} onClick={async () => { setBusy(s); try { await downloadAuth(`/api/export/${s}.csv${cid ? `?campaignId=${cid}` : ""}`, `${s}.csv`); } catch (e) { toast.push(errorMessage(e), "error"); } finally { setBusy(null); } }}>{titleCase(s)}</Button>)}</div>
    <p className="small muted" style={{ marginTop: 8 }}>Identity numbers and full phone numbers are never exported.</p>
  </Card>;
}
function Settings() {
  const can = useCan(); const toast = useToast(); const [key, setKey] = useState("review.sla_hours"); const q = trpc.ops.setting.useQuery({ key }, { enabled: /^[a-z0-9_.:-]{1,80}$/.test(key) }); const set = trpc.ops.setSetting.useMutation({ onSuccess: () => q.refetch() }); const [val, setVal] = useState(""); const record = trpc.ops.recordEvidence.useMutation(); const readiness = trpc.readiness.get.useQuery();
  return <div className="tt-grid c2">
    {can("settings.write") && <Card title="Settings"><div className="tt-col"><Input value={key} onChange={(e) => setKey(e.target.value)} mono placeholder="setting key" /><div className="small muted">Current: <span className="mono">{JSON.stringify(q.data ?? null)}</span></div><Input value={val} onChange={(e) => setVal(e.target.value)} mono placeholder='new value (JSON, e.g. 24 or "text")' /><div><Button variant="primary" loading={set.isPending} onClick={async () => { try { await set.mutateAsync({ key, value: JSON.parse(val) }); toast.push("Saved", "success"); } catch (e) { toast.push(errorMessage(e), "error"); } }}>Save</Button></div></div></Card>}
    {can("evidence.record") && <Card title="Record readiness evidence"><p className="small muted">Records that a piece of evidence exists and was accepted (link to the artefact). Feeds the activation validator.</p><div className="tt-col">{(["receipt_benchmark_accepted", "restore_rehearsal", "load_benchmark", "client_uat_signoff"] as const).map((k) => { const v = readiness.data?.evidence.find((e) => e.kind === k)?.value as { at?: string } | null | undefined; return <div key={k} className="tt-row"><span className="mono" style={{ minWidth: 240 }}>{k}</span>{v ? <Badge tone="success">recorded {fmtDate(v.at)}</Badge> : <Badge tone="warning">missing</Badge>}<Button size="sm" onClick={async () => { const ref = prompt("Reference to the evidence (path, link or ticket):"); if (ref == null) return; try { await record.mutateAsync({ kind: k, detail: { reference: ref } }); readiness.refetch(); toast.push("Recorded", "success"); } catch (e) { toast.push(errorMessage(e), "error"); } }}>Record</Button></div>; })}</div></Card>}
  </div>;
}

/* ---- Uptime & throughput: health samples the worker writes once a minute, bucketed for the chosen range. */
const RANGES: Array<{ h: number; label: string }> = [{ h: 1, label: "1 h" }, { h: 24, label: "24 h" }, { h: 168, label: "7 d" }, { h: 720, label: "30 d" }];
function RangePicker({ value, onChange }: { value: number; onChange: (h: number) => void }) { return <div className="seg" role="group" aria-label="Time range">{RANGES.map((r) => <button key={r.h} type="button" className={value === r.h ? "active" : ""} aria-pressed={value === r.h} onClick={() => onChange(r.h)}>{r.label}</button>)}</div>; }
const dur = (s: number) => s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172_800 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86_400).toFixed(1)} d`;
function History() {
  const [hours, setHours] = useState(24); const [table, setTable] = useState(false);
  const q = trpc.ops.healthHistory.useQuery({ sinceHours: hours }, { refetchInterval: 60_000, placeholderData: (prev) => prev });
  if (q.isLoading) return <Loading />; if (q.error) return <ErrorBox error={q.error} />; const d = q.data!; const a = d.availability;
  const series = (k: keyof (typeof d.buckets)[number]) => d.buckets.map((b) => ({ at: b.at, value: Number(b[k]) }));
  const latestOk = d.latest?.ok; const checks = (d.latest?.checks ?? {}) as Record<string, { ok?: boolean; mode?: string; provider?: string }>;
  return <div className="tt-stack" style={{ opacity: q.isFetching ? 0.7 : 1, transition: "opacity .15s" }}>
    <div className="filters"><RangePicker value={hours} onChange={setHours} /><span className="small muted">Samples every {d.intervalSec} s from the worker's housekeeping; buckets of {dur(d.bucketSec)}. {d.processes.length > 1 ? `${d.processes.length} processes reporting.` : ""}</span><span style={{ flex: 1 }} /><Button size="sm" onClick={() => setTable(!table)} aria-pressed={table}>{table ? "Show charts" : "Show table"}</Button></div>
    <div className="tt-grid c4">
      <div className="tt-card tt-stat"><div className="label">Availability, {RANGES.find((r) => r.h === hours)?.label}</div><div className="hero-num">{a.availabilityPct == null ? "–" : `${a.availabilityPct.toFixed(a.availabilityPct >= 99.95 ? 2 : 2)}%`}</div><div className="hint">{a.observedFrom ? `observed since ${fmtDate(a.observedFrom)} · ${dur(a.downtimeSec)} not reporting · ${dur(a.degradedSec)} degraded` : "no samples yet: the worker writes the first one about a minute after it starts"}</div></div>
      <Stat label="Now" value={d.latest ? <Badge tone={latestOk ? "success" : "danger"}>{latestOk ? "healthy" : "degraded"}</Badge> : "–"} hint={d.latest ? `last sample ${ago(d.latest.at)} · up ${dur(d.latest.uptimeSec)} · ${d.latest.memoryMb} MB · tick lag ${d.latest.tickLagMs} ms` : undefined} />
      <Stat label="Errors in range" value={d.errors.total} hint={`${d.errors.open} unresolved`} />
      <Stat label="Inbound messages" value={d.buckets.reduce((n, b) => n + b.inbound, 0)} hint={`${d.buckets.reduce((n, b) => n + b.processed, 0)} processed · ${d.buckets.reduce((n, b) => n + b.outbound, 0)} sent`} />
    </div>
    <Card title="Availability">
      <AvailabilityStrip buckets={d.buckets} bucketSec={d.bucketSec} from={d.since} until={d.now} />
      {Object.keys(checks).length > 0 && <div className="tt-row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>{Object.entries(checks).map(([k, v]) => <Badge key={k} tone={v?.ok === false ? "danger" : "success"}>{titleCase(k)}: {v?.ok === false ? "failing" : v?.mode ?? "ok"}</Badge>)}</div>}
      {a.gaps.length > 0 && <div style={{ marginTop: 12 }}><Table rows={a.gaps.slice(-10)} keyOf={(g) => g.from} cols={[{ h: "From", c: (g) => fmtDate(g.from) }, { h: "To", c: (g) => g.ongoing ? <Badge tone="danger">ongoing</Badge> : fmtDate(g.to) }, { h: "Duration", c: (g) => dur(g.seconds), num: true }, { h: "Kind", c: (g) => g.kind === "no_samples" ? "not reporting (process down or worker stalled)" : "degraded (a dependency check failed)" }]} /></div>}
    </Card>
    {table ? <Card title="Samples by bucket" flush><Table rows={[...d.buckets].reverse()} keyOf={(b) => b.at} cols={[{ h: "Bucket", c: (b) => fmtDate(b.at) }, { h: "Samples ok", c: (b) => `${b.okSamples}/${b.samples}` }, { h: "Inbound", c: (b) => b.inbound, num: true }, { h: "Processed", c: (b) => b.processed, num: true }, { h: "Sent", c: (b) => b.outbound, num: true }, { h: "Errors", c: (b) => b.errors, num: true }, { h: "Waiting", c: (b) => b.waitingEvents + b.waitingJobs, num: true }, { h: "Dead", c: (b) => b.deadLetters, num: true }, { h: "Outbound failures", c: (b) => b.outboundFailures, num: true }, { h: "Review overdue", c: (b) => b.reviewOverdue, num: true }, { h: "Tick lag ms", c: (b) => b.tickLagMs, num: true }, { h: "RSS MB", c: (b) => b.memoryMb, num: true }]} /></Card>
    : <div className="tt-grid c2">
      <Card><LineChart title="Inbound messages received" points={series("inbound")} unit="count" /></Card>
      <Card><LineChart title="Messages sent" points={series("outbound")} unit="count" /></Card>
      <Card><LineChart title="Errors recorded" points={series("errors")} unit="count" /></Card>
      <Card><LineChart title="Work waiting (events + jobs), peak per bucket" points={d.buckets.map((b) => ({ at: b.at, value: b.waitingEvents + b.waitingJobs }))} /></Card>
      <Card><LineChart title="Dead letters and outbound failures outstanding" points={d.buckets.map((b) => ({ at: b.at, value: b.deadLetters + b.outboundFailures }))} /></Card>
      <Card><LineChart title="Reviews past their target" points={series("reviewOverdue")} /></Card>
      <Card><LineChart title="Worker tick lag, peak per bucket" points={series("tickLagMs")} unit="ms" /></Card>
      <Card><LineChart title="Process memory (RSS)" points={series("memoryMb")} unit="MB" /></Card>
    </div>}
  </div>;
}

/* ---- Error log: every handled failure, grouped by fingerprint, resolvable with a note that lands in the audit log. */
function Errors() {
  const [hours, setHours] = useState(24); const [source, setSource] = useState(""); const [openOnly, setOpenOnly] = useState(true); const [sel, setSel] = useState<string | null>(null); const [resolving, setResolving] = useState<{ fingerprint?: string; id?: string; label: string } | null>(null);
  const can = useCan(); const toast = useToast();
  const sum = trpc.ops.errorSummary.useQuery({ sinceHours: hours, open: openOnly }, { refetchInterval: 30_000, placeholderData: (prev) => prev }); const sources = trpc.ops.errorSources.useQuery();
  const rows = (sum.data ?? []).filter((r) => !source || r.source === source);
  const occ = trpc.ops.errors.useQuery({ sinceHours: hours, fingerprint: sel ?? undefined, open: openOnly, limit: 100 }, { enabled: !!sel });
  const resolve = trpc.ops.resolveErrors.useMutation({ onSuccess: (r) => { toast.push(`${r.closed} occurrence${r.closed === 1 ? "" : "s"} resolved`, "success"); sum.refetch(); occ.refetch(); } });
  const selected = rows.find((r) => r.fingerprint === sel) ?? null;
  return <div className="tt-stack">
    <div className="filters"><RangePicker value={hours} onChange={setHours} /><Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source"><option value="">Every source</option>{(sources.data ?? []).map((s) => <option key={s} value={s}>{s}</option>)}</Select><Checkbox label="Unresolved only" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /><span className="small muted">Messages are redacted before they are stored: no phone numbers, identity numbers, tokens or stack traces.</span></div>
    <Card title={<>Failures by kind <span className="muted">({rows.length})</span></>} flush>
      {sum.isLoading ? <Loading /> : sum.error ? <ErrorBox error={sum.error} /> : <Table rows={rows} keyOf={(r) => r.fingerprint} onRow={(r) => setSel(sel === r.fingerprint ? null : r.fingerprint)} empty={openOnly ? "No unresolved failures in this range." : "No failures recorded in this range."} cols={[
        { h: "Count", c: (r) => <strong>{r.count}</strong>, num: true, w: 70 }, { h: "Source", c: (r) => <Badge tone={r.source === "console" ? "info" : r.source.startsWith("worker") ? "warning" : "danger"}>{r.source}</Badge> }, { h: "Code", c: (r) => <span className="mono small">{r.code}</span> }, { h: "Where", c: (r) => <span className="mono small">{r.path ?? "–"}</span> },
        { h: "Message", c: (r) => <span className="error-msg">{r.message}</span> }, { h: "Last seen", c: (r) => ago(r.lastAt) }, { h: "Open", c: (r) => r.open ? <Badge tone="danger">{r.open}</Badge> : <Badge tone="success">resolved</Badge>, num: true },
        { h: "", c: (r) => can("ops.alerts.ack") && r.open > 0 ? <Button size="sm" onClick={(e) => { e.stopPropagation(); setResolving({ fingerprint: r.fingerprint, label: `${r.open} open occurrence${r.open === 1 ? "" : "s"} of ${r.code}` }); }}>Resolve all</Button> : null },
      ]} />}
    </Card>
    {selected && <Card title={<>Occurrences · <span className="mono small">{selected.code}</span> <span className="muted small">fingerprint {selected.fingerprint}</span></>} actions={<Button size="sm" onClick={() => setSel(null)}>Close</Button>}>
      <p className="small muted">First seen {fmtDate(selected.firstAt)} · last {fmtDate(selected.lastAt)}. Correlation ids match the API request log and the audit log; references open the record concerned.</p>
      {occ.isLoading ? <Loading /> : occ.error ? <ErrorBox error={occ.error} /> : <Table rows={occ.data ?? []} keyOf={(e) => e.id} cols={[
        { h: "When", c: (e) => fmtDate(e.occurredAt) }, { h: "Message", c: (e) => <span className="error-msg">{e.message}</span> }, { h: "Correlation", c: (e) => <span className="mono small">{e.correlationId ?? "–"}</span> },
        { h: "References", c: (e) => e.ref ? <span className="small">{Object.entries(e.ref).map(([k, v]) => k === "submissionId" ? <Link key={k} to={`/submissions/${v}`}>{k} {v}</Link> : <span key={k} className="mono">{k} {v} </span>)}</span> : "–" },
        { h: "Actor", c: (e) => e.actorId ? <span className="mono small">{e.actorId}</span> : "system" }, { h: "Detail", c: (e) => e.detail ? <span className="mono small">{JSON.stringify(e.detail)}</span> : "–" },
        { h: "Status", c: (e) => e.resolvedAt ? <Badge tone="success">resolved {ago(e.resolvedAt)}</Badge> : can("ops.alerts.ack") ? <Button size="sm" onClick={() => setResolving({ id: e.id, label: `this occurrence of ${e.code}` })}>Resolve</Button> : <Badge tone="danger">open</Badge> },
      ]} />}
    </Card>}
    {resolving && <ActionDialog title="Resolve error" description={`Mark ${resolving.label} as dealt with. The note is recorded in the audit log.`} confirmLabel="Resolve" fields={[{ key: "note", label: "What was done", required: true, type: "textarea", placeholder: "e.g. provider outage 14:10–14:25, dead letters replayed" }]} onConfirm={async (v) => { await resolve.mutateAsync({ id: resolving.id, fingerprint: resolving.fingerprint, note: v.note }); }} onClose={() => setResolving(null)} />}
  </div>;
}

import { trpc } from "../lib/trpc.ts";
import { PageHead, Card, KV, Loading, ErrorBox, Badge, Table, Callout } from "../ui/kit.tsx";
import { fmtDate } from "../lib/format.ts";
export function ReadinessPage() {
  const q = trpc.readiness.get.useQuery();
  if (q.isLoading) return <Loading />; if (q.error) return <ErrorBox error={q.error} />; const r = q.data!;
  const lvl = r.levels as Record<string, boolean>; const level = lvl.production ? "Production" : lvl.integratedClientTesting ? "Integrated client testing" : "Locally testable";
  return <>
    <PageHead title="Readiness" sub="What this installation can honestly claim right now." />
    <div className="tt-stack">
      <Callout tone={lvl.production ? "success" : "info"}><strong>Readiness level: {level}.</strong> Environment <span className="mono">{r.environment}</span>{r.sampleData ? " · sample data present" : ""}.</Callout>
      <div className="tt-grid c3">
        <Card title="WhatsApp transport"><KV rows={[["Provider", r.providers.transport.provider], ["Mode", <Badge tone={r.providers.transport.mode === "configured" ? "success" : "warning"}>{r.providers.transport.mode}</Badge>], ["Note", (r.providers.transport as { note?: string }).note ?? "–"]]} /></Card>
        <Card title="Receipt extractor"><KV rows={[["Provider", r.providers.extractor.provider], ["Mode", <Badge tone={r.providers.extractor.mode === "real" ? "success" : "warning"}>{r.providers.extractor.mode}</Badge>], ["Model", r.providers.extractor.model ?? "–"], ["Health", r.providers.extractor.ok ? "ok" : r.providers.extractor.error ?? "not ok"]]} /></Card>
        <Card title="CRM"><KV rows={[["Provider", r.providers.crm.provider], ["Mode", <Badge tone={r.providers.crm.mode === "configured" ? "success" : "warning"}>{r.providers.crm.mode}</Badge>], ["Note", r.providers.crm.note ?? r.providers.crm.error ?? "–"]]} /></Card>
      </div>
      <Card title="Open client decisions that block production activation">
        <Table rows={r.openDecisions} keyOf={(d) => d.id} cols={[{ h: "ID", c: (d) => d.id }, { h: "Question", c: (d) => d.question }, { h: "Test value in use", c: (d) => d.testValue ?? "–" }]} empty="No open blocking decisions" />
      </Card>
      <Card title="Evidence recorded">
        <Table rows={r.evidence} keyOf={(e) => e.kind} cols={[{ h: "Kind", c: (e) => e.kind }, { h: "Recorded", c: (e) => e.value ? fmtDate((e.value as { at?: string }).at) : <Badge tone="warning">missing</Badge> }, { h: "Detail", c: (e) => e.value ? <span className="small mono wrap">{JSON.stringify(e.value).slice(0, 200)}</span> : "–" }]} />
      </Card>
      {r.activation && <Card title={<h2>Production activation validator {r.activation.ok ? <Badge tone="success">would pass</Badge> : <Badge tone="danger">{r.activation.failures.filter((f) => f.blocking).length} blocking</Badge>}</h2>}>
        <Table rows={r.activation.failures} keyOf={(f) => f.code} cols={[{ h: "Code", c: (f) => <span className="mono">{f.code}</span> }, { h: "Finding", c: (f) => f.message }, { h: "Blocks", c: (f) => f.blocking ? <Badge tone="danger">yes</Badge> : <Badge>advisory</Badge> }]} empty="No findings" />
      </Card>}
    </div>
  </>;
}

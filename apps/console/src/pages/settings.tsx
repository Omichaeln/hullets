/**
 * Settings — the platform administrator's page, separate from the work of running
 * a promotion and from the technical logs.
 *
 * Two honest facts shape this page. First, almost everything a person might call
 * a "setting" lives somewhere more specific: the rules of a promotion are a
 * versioned campaign, provider credentials are environment variables the console
 * only reads, and people are accounts under Access. This page says so, so nobody
 * hunts here for them. Second, the settings store itself is a small JSON
 * key/value table with exactly one key the running system consumes
 * (`sample_data`, a stamp written by the sample seed) and a family of evidence
 * stamps written from the Readiness page. The raw editor that used to sit under
 * "Integrations & queues" is kept, because a platform administrator sometimes
 * needs it, but it is labelled as the advanced tool it is rather than presented
 * as the way to configure the system.
 */
import { useState } from "react";
import { trpc, errorMessage } from "../lib/trpc.ts";
import { useCan } from "../lib/auth.tsx";
import { Link } from "../lib/router.tsx";
import { PageHead, Card, Table, Badge, Button, Input, Callout, Loading, ErrorBox, useToast } from "../ui/kit.tsx";
import { fmtDate } from "../lib/format.ts";

/** What each key that the system actually reads is for, and where it is written. */
const KNOWN: Record<string, { what: string; writtenBy: string; handEdit: boolean }> = {
  sample_data: { what: "Stamp that TEST ONLY sample data is loaded. Drives the “Sample data” badge and the readiness report.", writtenBy: "npm run seed / reset:sample", handEdit: false },
};
const describe = (key: string) => KNOWN[key] ?? (key.startsWith("evidence.")
  ? { what: "Readiness evidence: a piece of acceptance evidence exists and was accepted. Feeds the activation validator.", writtenBy: "Readiness → Record", handEdit: false }
  : { what: "Not read by any part of the running system.", writtenBy: "this page", handEdit: true });

export function SettingsPage() {
  const can = useCan(); const toast = useToast();
  const rows = trpc.ops.settings.useQuery();
  const set = trpc.ops.setSetting.useMutation({ onSuccess: () => rows.refetch() });
  const [key, setKey] = useState(""); const [val, setVal] = useState(""); const [err, setErr] = useState<string | null>(null);
  const keyOk = /^[a-z0-9_.:-]{1,80}$/.test(key);
  const save = async () => {
    setErr(null);
    let parsed: unknown;
    try { parsed = JSON.parse(val); } catch { setErr("The value must be JSON — a number, a quoted string, true/false, or an object."); return; }
    try { await set.mutateAsync({ key, value: parsed }); toast.push(`Saved ${key}`, "success"); setKey(""); setVal(""); }
    catch (e) { setErr(errorMessage(e)); }
  };
  return <>
    <PageHead title="Settings" sub="Platform settings. The things people usually look for here live elsewhere — see below." />
    <div className="tt-stack">
      <Card title="Where things are configured">
        <div className="tt-grid c3">
          <div><strong>The promotion's rules and content</strong><p className="small muted">Qualification, prizes, periods, messages. They are a versioned campaign, activated under dual control.</p><Link to="/campaigns" className="btn sm">Campaigns</Link></div>
          <div><strong>Shops and products</strong><p className="small muted">Master data shared by every campaign; which shops take part is set per campaign.</p><Link to="/master-data" className="btn sm">Outlets &amp; products</Link></div>
          <div><strong>People and roles</strong><p className="small muted">Staff accounts, temporary passwords and the permission matrix.</p><Link to="/staff" className="btn sm">Access</Link></div>
        </div>
        <Callout tone="info"><strong>Providers are not set here.</strong> WhatsApp, the receipt extractor, the CRM and storage are configured by environment variables on the deployment. The console reads their state under <Link to="/ops">Integrations &amp; queues → Health</Link> and never writes it.</Callout>
      </Card>

      <Card title="Stored settings">
        {rows.isPending ? <Loading /> : rows.error ? <ErrorBox error={rows.error} /> : <Table
          rows={rows.data} keyOf={(r) => r.key} empty="Nothing is stored yet."
          cols={[
            { h: "Key", c: (r) => <span className="mono">{r.key}</span> },
            { h: "What it is", c: (r) => { const d = describe(r.key); return <><div>{d.what}</div><div className="small muted">Written by {d.writtenBy}</div></>; } },
            { h: "Value", c: (r) => <span className="small mono wrap">{JSON.stringify(r.value).slice(0, 160)}</span> },
            { h: "Updated", c: (r) => <><div>{fmtDate(r.updatedAt)}</div><div className="small muted">{r.updatedBy ?? "—"}</div></> },
            { h: "", c: (r) => describe(r.key).handEdit ? null : <Badge tone="warning">managed</Badge> },
          ]}
        />}
      </Card>

      {can("settings.write") && <Card title="Advanced: set a raw value">
        <Callout tone="warning">Keys are free-form and nothing validates them. A key the running system does not read has no effect; a managed key set by hand will be overwritten by the process that owns it. Every write is recorded in the audit log under your name.</Callout>
        <div className="tt-grid c2" style={{ marginTop: 12 }}>
          <div className="field"><label>Key</label><Input mono value={key} onChange={(e) => setKey(e.target.value)} placeholder="lower-case, dots and dashes" />{key && !keyOk && <div className="error">Lower-case letters, digits, dots, dashes, colons and underscores only.</div>}</div>
          <div className="field"><label>Value (JSON)</label><Input mono value={val} onChange={(e) => setVal(e.target.value)} placeholder='e.g. 24 or "text" or {"a":1}' /></div>
        </div>
        {err && <Callout tone="danger">{err}</Callout>}
        <div style={{ marginTop: 12 }}><Button variant="primary" disabled={!keyOk || !val.trim()} loading={set.isPending} onClick={save}>Save</Button></div>
      </Card>}
    </div>
  </>;
}

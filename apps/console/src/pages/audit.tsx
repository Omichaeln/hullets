import { useState } from "react";
import { trpc, errorMessage } from "../lib/trpc.ts";
import { PageHead, Card, Table, Input, Button, Loading, ErrorBox, Badge, Json, useToast } from "../ui/kit.tsx";
import { fmtDate } from "../lib/format.ts";
export function AuditPage() {
  const [f, setF] = useState({ action: "", targetType: "", targetId: "", actorId: "" }); const [offset, setOffset] = useState(0); const [open, setOpen] = useState<number | null>(null); const toast = useToast();
  const list = trpc.audit.list.useQuery({ action: f.action || undefined, targetType: f.targetType || undefined, targetId: f.targetId || undefined, actorId: f.actorId || undefined, limit: 50, offset });
  const verify = trpc.audit.verify.useQuery(undefined, { enabled: false }); const checkpoint = trpc.audit.checkpoint.useMutation();
  return <>
    <PageHead title="Audit log" sub="Hash-chained, append-only record of every consequential action." actions={<><Button onClick={() => verify.refetch()} loading={verify.isFetching}>Verify chain</Button><Button onClick={async () => { try { const c = await checkpoint.mutateAsync(); toast.push(c ? `Checkpoint ${c.id} (${c.signed ? "signed" : "unsigned"})` : "Nothing to checkpoint", "success"); } catch (e) { toast.push(errorMessage(e), "error"); } }} loading={checkpoint.isPending}>Sign checkpoint</Button></>} />
    {verify.data && <div className={`callout ${verify.data.ok ? "success" : "danger"}`} style={{ marginBottom: 16 }}>{verify.data.ok ? `Chain intact: ${verify.data.total} events verified.` : `Chain BROKEN: ${verify.data.brokenCount} problem(s); first at ${JSON.stringify(verify.data.broken[0])}`}</div>}
    <Card>
      <div className="form-row" style={{ marginBottom: 12 }}>
        <Input placeholder="Action (e.g. draw.approved)" value={f.action} onChange={(e) => { setOffset(0); setF({ ...f, action: e.target.value }); }} />
        <Input placeholder="Target type" value={f.targetType} onChange={(e) => { setOffset(0); setF({ ...f, targetType: e.target.value }); }} />
        <Input placeholder="Target id" value={f.targetId} onChange={(e) => { setOffset(0); setF({ ...f, targetId: e.target.value }); }} />
        <Input placeholder="Actor id" value={f.actorId} onChange={(e) => { setOffset(0); setF({ ...f, actorId: e.target.value }); }} />
      </div>
      {list.error && <ErrorBox error={list.error} />}{list.isLoading ? <Loading /> : <Table rows={list.data ?? []} keyOf={(a) => String(a.id)} onRow={(a) => setOpen(open === a.id ? null : a.id)} cols={[{ h: "#", c: (a) => a.id, num: true }, { h: "When", c: (a) => fmtDate(a.createdAt) }, { h: "Actor", c: (a) => <><Badge>{a.actorType}</Badge> <span className="mono small">{a.actorId}</span></> }, { h: "Action", c: (a) => <span className="mono">{a.action}</span> }, { h: "Target", c: (a) => <span className="mono small">{a.targetType}/{a.targetId}</span> }, { h: "Reason", c: (a) => a.reason ?? "" }, { h: "Hash", c: (a) => <span className="mono small">{a.entryHash.slice(0, 12)}…</span> }]} />}
      {open != null && list.data?.find((a) => a.id === open) && <div style={{ marginTop: 12 }}><Json value={list.data.find((a) => a.id === open)} /></div>}
      <div className="tt-row" style={{ marginTop: 12 }}><Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Newer</Button><Button size="sm" disabled={(list.data?.length ?? 0) < 50} onClick={() => setOffset(offset + 50)}>Older</Button></div>
    </Card>
  </>;
}

import { useState } from "react";
import { trpc, errorMessage } from "../lib/trpc.ts";
import { PageHead, Card, Button, Input, Select, Loading, Callout, Badge, useToast } from "../ui/kit.tsx";
import { fmtDate } from "../lib/format.ts";
const QUICK = ["hi", "1", "2", "3", "4", "5", "6", "7", "9", "yes", "back", "menu", "cancel", "support"];
export function SimulatorPage() {
  const toast = useToast(); const [phone, setPhone] = useState("263771000001"); const [text, setText] = useState(""); const [fixture, setFixture] = useState(""); const [file, setFile] = useState<File | null>(null);
  const fixtures = trpc.simulator.fixtures.useQuery(); const transcript = trpc.simulator.transcript.useQuery({ phone }, { enabled: phone.length >= 6, refetchInterval: 5000 }); const inbound = trpc.simulator.inbound.useMutation({ onSuccess: () => transcript.refetch() }); const img = trpc.useUtils().simulator.fixtureImage;
  const cfg = trpc.public.config.useQuery();
  const send = async (t?: string) => { try { await inbound.mutateAsync({ phone, text: t ?? text }); setText(""); } catch (e) { toast.push(errorMessage(e), "error"); } };
  const sendImage = async () => { try { let b64: string; let mime = "image/jpeg"; if (file) { const buf = await file.arrayBuffer(); b64 = btoa(String.fromCharCode(...new Uint8Array(buf))); mime = file.type || mime; } else if (fixture) { b64 = (await img.fetch({ file: fixture })).b64; } else return; await inbound.mutateAsync({ phone, imageB64: b64, mime }); } catch (e) { toast.push(errorMessage(e), "error"); } };
  const f = fixtures.data?.find((x) => x.file === fixture);
  return <>
    <PageHead title="WhatsApp simulator" sub="TEST ONLY: injects inbound messages exactly as the webhook would, through the same queue, worker, pipeline and outbox. Nothing is sent to a phone." />
    {cfg.data?.transport === "configured" && <Callout tone="warning">The real WhatsApp transport is configured. Simulator messages still bypass WhatsApp, but replies to real numbers on the allowlist would be delivered.</Callout>}
    <div className="tt-grid" style={{ gridTemplateColumns: "minmax(300px, 1fr) 1.4fr", marginTop: 16 }}>
      <div className="tt-col">
        <Card title="Participant phone"><Input value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ""))} mono /><p className="small muted" style={{ marginTop: 6 }}>Use a fictional number per test persona. Registration identity numbers must not be real.</p></Card>
        <Card title="Text message"><form className="tt-row" onSubmit={(e) => { e.preventDefault(); void send(); }}><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type as the participant…" style={{ flex: 1 }} /><Button type="submit" variant="primary" loading={inbound.isPending}>Send</Button></form><div className="tt-row" style={{ marginTop: 8 }}>{QUICK.map((q) => <Button key={q} size="sm" onClick={() => send(q)}>{q}</Button>)}<Button size="sm" onClick={async () => { try { await inbound.mutateAsync({ phone, kind: "unsupported" }); } catch (e) { toast.push(errorMessage(e), "error"); } }}>voice note</Button></div></Card>
        <Card title="Receipt photo"><div className="tt-col"><Select value={fixture} onChange={(e) => { setFixture(e.target.value); setFile(null); }}><option value="">Choose a fixture…</option>{fixtures.data?.map((x) => <option key={x.file} value={x.file}>{x.id} — {x.notes}</option>)}</Select>{f && <div className="small muted">Expected: {JSON.stringify(f.expect)}</div>}<div className="tt-row"><span className="small muted">or upload</span><input type="file" accept="image/*" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setFixture(""); }} /></div><div><Button variant="primary" disabled={!fixture && !file} loading={inbound.isPending} onClick={sendImage}>Send photo</Button></div></div></Card>
      </div>
      <Card title={<h2>Transcript <span className="mono muted">{transcript.data?.phone}</span></h2>} actions={<Button size="sm" onClick={() => transcript.refetch()}>Refresh</Button>}>
        {transcript.isLoading ? <Loading /> : <div className="chat">{(transcript.data?.transcript ?? []).map((m, i) => <div key={i} className={`bubble ${m.dir}`}>{m.text || <i className="muted">[{"kind" in m ? m.kind : "message"}]</i>}<span className="meta">{fmtDate(m.at)} · <Badge status={m.status} /></span></div>)}{!transcript.data?.transcript.length && <div className="empty">No messages yet. Say "hi".</div>}</div>}
      </Card>
    </div>
  </>;
}

import { useState } from "react";
import { trpc, errorMessage } from "../lib/trpc.ts";
import { useCan } from "../lib/auth.tsx";
import { Link } from "../lib/router.tsx";
import { PageHead, Card, Table, Badge, Button, Loading, ErrorBox, Input, Textarea, KV, useToast } from "../ui/kit.tsx";
import { fmtDate, ago } from "../lib/format.ts";
export function SupportPage() {
  const can = useCan(); const toast = useToast(); const queue = trpc.support.queue.useQuery(undefined, { refetchInterval: 15_000 }); const [phone, setPhone] = useState(""); const [lookup, setLookup] = useState("");
  const conv = trpc.support.conversation.useQuery({ phone: lookup }, { enabled: !!lookup, refetchInterval: 10_000 }); const claim = trpc.support.claim.useMutation({ onSuccess: () => { conv.refetch(); queue.refetch(); } }); const release = trpc.support.release.useMutation({ onSuccess: () => { conv.refetch(); queue.refetch(); } }); const send = trpc.support.send.useMutation({ onSuccess: () => conv.refetch() }); const [text, setText] = useState("");
  return <>
    <PageHead title="Support" sub="Participants who asked for a person. Claiming a conversation pauses the automated flow until you release it." actions={<form className="tt-row" onSubmit={(e) => { e.preventDefault(); setLookup(phone); }}><Input placeholder="Phone number" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ width: 200 }} /><Button type="submit">Open conversation</Button></form>} />
    <div className="tt-grid" style={{ gridTemplateColumns: "minmax(280px, 1fr) 2fr" }}>
      <Card title={`Waiting (${queue.data?.length ?? 0})`} flush>{queue.isLoading ? <Loading /> : queue.error ? <ErrorBox error={queue.error} /> : <Table rows={queue.data ?? []} keyOf={(r) => r.conversationId} onRow={(r) => { setPhone(r.uid); setLookup(r.uid); }} cols={[{ h: "Who", c: (r) => <>{r.name ?? "unregistered"}<div className="small muted mono">{r.phone}</div></> }, { h: "Owner", c: (r) => r.handoffOwner === "queue" ? <Badge tone="warning">unclaimed</Badge> : <Badge tone="info">{r.handoffOwner}</Badge> }, { h: "Since", c: (r) => ago(r.handoffSince) }]} empty="Nobody is waiting." />}</Card>
      <Card title={conv.data ? <h2>Conversation with {conv.data.participant ? `${conv.data.participant.firstName} ${conv.data.participant.surname}` : "unregistered"} <span className="mono muted">{conv.data.phone}</span></h2> : "Conversation"} actions={conv.data && can("support.handoff") && <>{conv.data.session?.handoffOwner ? <Button size="sm" onClick={() => release.mutate({ phone: lookup })}>Release to automation</Button> : <Button size="sm" variant="primary" onClick={() => claim.mutate({ phone: lookup })}>Claim</Button>}</>}>
        {!lookup ? <div className="empty">Pick a waiting conversation or enter a phone number.</div> : conv.isLoading ? <Loading /> : conv.error ? <ErrorBox error={conv.error} /> : conv.data && <div className="tt-col">
          <KV rows={[["State", conv.data.session ? `${conv.data.session.state}${conv.data.session.handoffOwner ? ` · handled by ${conv.data.session.handoffOwner} since ${fmtDate(conv.data.session.handoffSince)}` : ""}` : "no session"], ["Participant", conv.data.participant ? <Link to={`/participants/${conv.data.participant.id}`}>{conv.data.participant.firstName} {conv.data.participant.surname} · {conv.data.participant.status}</Link> : "not registered"]]} />
          <div className="chat">{conv.data.transcript.map((m) => <div key={m.id} className={`bubble ${m.dir}`}>{m.text || <i className="muted">[{"kind" in m ? m.kind : "message"}]</i>}<span className="meta">{fmtDate(m.at)} · {m.status}{"purpose" in m ? ` · ${m.purpose}` : ""}</span></div>)}</div>
          {can("support.handoff") && <form className="tt-row" onSubmit={async (e) => { e.preventDefault(); try { await send.mutateAsync({ phone: lookup, text }); setText(""); } catch (e2) { toast.push(errorMessage(e2), "error"); } }}><Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={conv.data.session?.handoffOwner ? "Reply as the support team…" : "Claim the conversation to reply"} disabled={!conv.data.session?.handoffOwner} style={{ minHeight: 60, flex: 1 }} /><Button type="submit" variant="primary" disabled={!text.trim() || !conv.data.session?.handoffOwner} loading={send.isPending}>Send</Button></form>}
        </div>}
      </Card>
    </div>
  </>;
}

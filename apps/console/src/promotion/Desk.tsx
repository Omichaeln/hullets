/**
 * The promotion desk — what the client's promotion administrator and their
 * assistants see. Four screens, plain language, no codes.
 *
 * Which console a person gets is decided by the ROLES ON THEIR ACCOUNT, not by
 * a preference they could lose (see app.tsx). Someone who also holds a technical
 * role gets a way back to the full console; nobody else does.
 *
 * The desk keeps its own screen state rather than adding four routes to the
 * technical router: it is a separate shell with four destinations, and the two
 * navigations have nothing to say to each other.
 */
import { useEffect, useMemo, useState } from "react";
import { trpc, session, errorMessage } from "../lib/trpc.ts";
import { useMe } from "../lib/auth.tsx";
import { Brand, Button, Card, Stat, Badge, Field, Input, Select, Table, Empty, Loading, ErrorBox, Callout, ActionDialog, Textarea, PageHead } from "../ui/kit.tsx";

type Screen = "today" | "entries" | "submissions" | "queries";
const SCREENS: Array<[Screen, string]> = [["today", "Today"], ["entries", "Entries"], ["submissions", "Submissions"], ["queries", "Queries"]];
const SCREEN_KEY = "hullets.desk.screen";

/** The pipeline's status codes, in the promotion's language. */
const OUTCOME_LABEL: Record<string, string> = {
  qualified: "Earned an entry", review: "Needs a look", not_qualified: "Did not qualify",
  duplicate: "Already claimed", reupload: "Photo unreadable",
  received: "Still being read", processing: "Still being read", delayed: "Still being read",
};
const OUTCOME_TONE: Record<string, "success" | "warning" | "danger" | "info" | undefined> = {
  qualified: "success", review: "warning", not_qualified: "danger", duplicate: "danger", reupload: "warning",
};
const outcomeLabel = (s: string | null) => (s ? OUTCOME_LABEL[s] ?? s : "—");

/**
 * "Packs bought" is what the rules counted, not what was printed. It is null
 * both when the photo could not be read and when no qualifying product was
 * found — two different ways of saying "we cannot tell", neither of which is
 * the same statement as "they bought none".
 */
const packs = (n: number | null | undefined) => (n == null ? <span className="muted">not read</span> : n);
const when = (t: string | null | undefined) => (t ? new Date(t).toLocaleString() : "—");

// ---------------------------------------------------------------- filters

type FilterState = {
  period: string; retailer: string; outletId: string; town: string; region: string;
  packsMin: string; packsMax: string; receiptsMin: string; receiptsMax: string; search: string;
};
const EMPTY: FilterState = { period: "", retailer: "", outletId: "", town: "", region: "", packsMin: "", packsMax: "", receiptsMin: "", receiptsMax: "", search: "" };
const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
/** Only send what was actually set; an empty box is not a filter. */
const toQuery = (f: FilterState) => ({
  period: f.period || undefined, retailer: f.retailer || undefined, outletId: f.outletId || undefined,
  town: f.town || undefined, region: f.region || undefined, search: f.search.trim() || undefined,
  packsMin: num(f.packsMin), packsMax: num(f.packsMax), receiptsMin: num(f.receiptsMin), receiptsMax: num(f.receiptsMax),
});

type Facets = {
  periods: Array<{ code: string; label: string }>;
  retailers: string[];
  outlets: Array<{ id: string; retailer: string; branch: string; town: string; region: string }>;
  towns: string[]; regions: string[];
};

function Filters({ facets, value, onChange }: { facets: Facets | undefined; value: FilterState; onChange: (f: FilterState) => void }) {
  const set = (k: keyof FilterState, v: string) => {
    // Choosing a different retailer cannot leave a branch from the old one selected.
    const next = { ...value, [k]: v };
    if (k === "retailer" && value.outletId) next.outletId = "";
    onChange(next);
  };
  // Branches narrow to the chosen retailer: a flat list of every branch in the
  // country is not a filter anyone can use.
  const branches = useMemo(
    () => (facets?.outlets ?? []).filter((o) => !value.retailer || o.retailer === value.retailer),
    [facets, value.retailer],
  );
  const dirty = JSON.stringify(value) !== JSON.stringify(EMPTY);
  return <div className="desk-filters">
    <Field label="Period"><Select value={value.period} onChange={(e) => set("period", e.target.value)}>
      <option value="">All weeks</option>{facets?.periods.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
    </Select></Field>
    <Field label="Shop"><Select value={value.retailer} onChange={(e) => set("retailer", e.target.value)}>
      <option value="">All shops</option>{facets?.retailers.map((r) => <option key={r} value={r}>{r}</option>)}
    </Select></Field>
    <Field label="Branch"><Select value={value.outletId} onChange={(e) => set("outletId", e.target.value)}>
      <option value="">All branches</option>{branches.map((o) => <option key={o.id} value={o.id}>{o.retailer} — {o.branch}</option>)}
    </Select></Field>
    <Field label="Town"><Select value={value.town} onChange={(e) => set("town", e.target.value)}>
      <option value="">Anywhere</option>{facets?.towns.map((t) => <option key={t} value={t}>{t}</option>)}
    </Select></Field>
    <Field label="Province"><Select value={value.region} onChange={(e) => set("region", e.target.value)}>
      <option value="">Anywhere</option>{facets?.regions.map((r) => <option key={r} value={r}>{r}</option>)}
    </Select></Field>
    <Field label="Packs bought" help="What the rules counted">
      <div className="desk-range">
        <Input inputMode="numeric" placeholder="any" value={value.packsMin} onChange={(e) => set("packsMin", e.target.value)} aria-label="Packs bought, from" />
        <span>to</span>
        <Input inputMode="numeric" placeholder="any" value={value.packsMax} onChange={(e) => set("packsMax", e.target.value)} aria-label="Packs bought, to" />
      </div>
    </Field>
    <Field label="Receipts sent by that person" help="Including ones that did not qualify">
      <div className="desk-range">
        <Input inputMode="numeric" placeholder="any" value={value.receiptsMin} onChange={(e) => set("receiptsMin", e.target.value)} aria-label="Receipts sent, from" />
        <span>to</span>
        <Input inputMode="numeric" placeholder="any" value={value.receiptsMax} onChange={(e) => set("receiptsMax", e.target.value)} aria-label="Receipts sent, to" />
      </div>
    </Field>
    <Field label="Name or number"><Input placeholder="search" value={value.search} onChange={(e) => set("search", e.target.value)} /></Field>
    <div className="desk-filters-actions">
      <Button variant="ghost" disabled={!dirty} onClick={() => onChange(EMPTY)}>Clear filters</Button>
    </div>
  </div>;
}

// ---------------------------------------------------------------- screens

function Today({ onGo }: { onGo: (s: Screen, outcome?: string) => void }) {
  const q = trpc.promotion.today.useQuery({});
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  if (!d.campaignId) return <Empty>No campaign is running yet.</Empty>;
  return <>
    <PageHead title="Today" sub="Is anything waiting?" />
    <div className="desk-tiles">
      {/* Two of these are jobs, so they are buttons. The rest are the shape of the week. */}
      <button className="desk-tile act" onClick={() => onGo("queries")}>
        <Stat label="People waiting for an answer" value={d.waitingQueries} hint="Automatic replies are paused for them" />
      </button>
      <button className="desk-tile act" onClick={() => onGo("submissions", "review")}>
        <Stat label="Receipts needing a look" value={d.waitingReview} hint="Decided by the platform team today — ask if this should be yours" />
      </button>
      <div className="desk-tile"><Stat label="Entries in the draw" value={d.entries} /></div>
      <div className="desk-tile"><Stat label="People taking part" value={d.participants} /></div>
    </div>
    <Card title="Receipts by outcome">
      <div className="desk-outcomes">
        {Object.entries(d.byOutcome).map(([status, n]) => (
          <button key={status} className="desk-outcome" onClick={() => onGo("submissions", status)}>
            <Badge tone={OUTCOME_TONE[status]}>{outcomeLabel(status)}</Badge>
            <strong>{n as number}</strong>
          </button>
        ))}
        {!Object.keys(d.byOutcome).length && <Empty>No receipts yet.</Empty>}
      </div>
    </Card>
  </>;
}

function Entries({ facets, canDecide }: { facets: Facets | undefined; canDecide: boolean }) {
  const [f, setF] = useState<FilterState>(EMPTY);
  const [acting, setActing] = useState<{ id: string; mode: "disqualify" | "reinstate" } | null>(null);
  const q = trpc.promotion.entries.useQuery({ ...toQuery(f), limit: 100, offset: 0 });
  const utils = trpc.useUtils();
  const disqualify = trpc.entries.disqualify.useMutation();
  const reinstate = trpc.entries.reinstate.useMutation();
  return <>
    <PageHead title="Entries" sub="Every entry that has been earned. One entry is one purchase that met the rules." />
    <Card flush><Filters facets={facets} value={f} onChange={setF} /></Card>
    {q.error && <ErrorBox error={q.error} />}
    <div className="desk-count">{q.isPending ? "…" : `${q.data?.rows.length ?? 0} entries`}{q.data?.next ? " (first 100)" : ""}</div>
    {q.isPending ? <Loading /> : <Table
      keyOf={(r) => r.entryId}
      rows={q.data?.rows ?? []}
      empty="Nothing matches those filters."
      cols={[
        { h: "Person", c: (r) => <><div>{r.name}</div><div className="muted">{r.phone}</div></> },
        { h: "Shop", c: (r) => <><div>{r.retailer ?? "—"}</div><div className="muted">{r.branch ?? ""}</div></> },
        { h: "Where", c: (r) => <><div>{r.town ?? "—"}</div><div className="muted">{r.region ?? ""}</div></> },
        { h: "Packs", num: true, c: (r) => packs(r.packs) },
        { h: "Their receipts", num: true, c: (r) => r.receiptsByPerson },
        { h: "Week", c: (r) => r.period ?? "—" },
        { h: "Standing", c: (r) => <Badge tone={r.status === "active" ? "success" : "danger"}>{r.status === "active" ? "Counting" : "Taken out"}</Badge> },
        { h: "Earned", c: (r) => when(r.awardedAt) },
        ...(canDecide ? [{
          h: "", c: (r: { entryId: string; status: string }) => (r.status === "active"
            ? <Button size="sm" variant="ghost" onClick={() => setActing({ id: r.entryId, mode: "disqualify" })}>Disqualify</Button>
            : <Button size="sm" variant="ghost" onClick={() => setActing({ id: r.entryId, mode: "reinstate" })}>Put back</Button>),
        }] : []),
      ]}
    />}
    {acting && <ActionDialog
      title={acting.mode === "disqualify" ? "Disqualify this entry" : "Put this entry back"}
      description={<>The reason is not optional: it is written into the tamper-evident audit trail with your name and shown to auditors. If the entry is already in a locked draw the system will ask for a second person's approval before it will act — that is what stops one person quietly changing a draw's outcome.</>}
      confirmLabel={acting.mode === "disqualify" ? "Disqualify" : "Put back"}
      danger={acting.mode === "disqualify"}
      fields={[{ key: "reason", label: "Reason", type: "textarea", required: true, placeholder: "Why is this entry being changed?" }]}
      onClose={() => setActing(null)}
      onConfirm={async (v) => {
        const args = { entryId: acting.id, reason: v.reason };
        await (acting.mode === "disqualify" ? disqualify.mutateAsync(args) : reinstate.mutateAsync(args));
        await utils.promotion.entries.invalidate();
        setActing(null);
      }}
    />}
  </>;
}

function Submissions({ facets, initialOutcome }: { facets: Facets | undefined; initialOutcome?: string }) {
  const [f, setF] = useState<FilterState>(EMPTY);
  const [outcome, setOutcome] = useState<string>(initialOutcome ?? "");
  useEffect(() => { if (initialOutcome) setOutcome(initialOutcome); }, [initialOutcome]);
  const q = trpc.promotion.submissions.useQuery({ ...toQuery(f), outcome: outcome || undefined, limit: 100, offset: 0 });
  const chips: Array<[string, string]> = [["", "Everything"], ["qualified", "Earned an entry"], ["review", "Needs a look"], ["not_qualified", "Did not qualify"], ["duplicate", "Already claimed"], ["reupload", "Photo unreadable"], ["pending", "Still being read"]];
  return <>
    <PageHead title="Submissions" sub="Every receipt that was sent in, whatever happened to it. This is the screen that answers “why did this one not count?”" />
    <div className="desk-chips">
      {chips.map(([v, label]) => <button key={v || "all"} className={outcome === v ? "on" : ""} onClick={() => setOutcome(v)}>{label}</button>)}
    </div>
    <Card flush><Filters facets={facets} value={f} onChange={setF} /></Card>
    {q.error && <ErrorBox error={q.error} />}
    <div className="desk-count">{q.isPending ? "…" : `${q.data?.rows.length ?? 0} receipts`}{q.data?.next ? " (first 100)" : ""}</div>
    {q.isPending ? <Loading /> : <Table
      keyOf={(r) => r.submissionId}
      rows={q.data?.rows ?? []}
      empty="Nothing matches those filters."
      cols={[
        { h: "Person", c: (r) => <><div>{r.name}</div><div className="muted">{r.phone}</div></> },
        { h: "Outcome", c: (r) => <><Badge tone={OUTCOME_TONE[r.status]}>{outcomeLabel(r.status)}</Badge>{r.reason && <div className="muted">{r.reason.replace(/_/g, " ")}</div>}</> },
        { h: "Shop", c: (r) => <><div>{r.retailer ?? "—"}</div><div className="muted">{r.branch ?? ""}</div></> },
        { h: "Where", c: (r) => <><div>{r.town ?? "—"}</div><div className="muted">{r.region ?? ""}</div></> },
        { h: "Packs", num: true, c: (r) => packs(r.packs) },
        { h: "Their receipts", num: true, c: (r) => r.receiptsByPerson },
        { h: "Week", c: (r) => r.period ?? "—" },
        { h: "Sent", c: (r) => when(r.sentAt) },
        { h: "Reference", c: (r) => <span className="mono">{r.reference}</span> },
      ]}
    />}
  </>;
}

/**
 * Queries: the people who asked for a human. While a query is open the automatic
 * replies stop for that person, so each one needs an answer and then handing
 * back. The LIST is the point — the technical console makes you type a phone
 * number, which only works if you already know who is waiting.
 */
function Queries() {
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const queue = trpc.support.queue.useQuery();
  const utils = trpc.useUtils();
  const convo = trpc.support.conversation.useQuery({ phone: open ?? "" }, { enabled: !!open });
  const claim = trpc.support.claim.useMutation();
  const release = trpc.support.release.useMutation();
  const send = trpc.support.send.useMutation();
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await utils.support.invalidate(); } catch (e) { setErr(errorMessage(e)); } };
  return <>
    <PageHead title="Queries" sub="People who asked for a human. Automatic replies are paused for them until you hand the conversation back." />
    {err && <Callout tone="danger">{err}</Callout>}
    {queue.isPending ? <Loading /> : !queue.data?.length ? <Empty>Nobody is waiting.</Empty> : queue.data.map((c) => (
      <Card key={c.conversationId} title={<span>{c.name ?? "Unknown participant"} <span className="muted">{c.phone}</span></span>}
        actions={<>
          <Button size="sm" variant="ghost" onClick={() => { setOpen(open === c.uid ? null : c.uid); setDraft(""); }}>{open === c.uid ? "Close" : "Open"}</Button>
          {c.handoffOwner
            ? <Button size="sm" onClick={() => run(() => release.mutateAsync({ phone: c.uid }))}>Done — hand back</Button>
            : <Button size="sm" onClick={() => run(() => claim.mutateAsync({ phone: c.uid }))}>Take this one</Button>}
        </>}>
        <div className="muted">Waiting since {when(c.handoffSince)}{c.handoffOwner ? "" : " · nobody has taken it yet"}</div>
        {open === c.uid && <>
          <div className="desk-transcript">
            {convo.isPending ? <Loading /> : (convo.data?.transcript ?? []).map((t) => (
              <div key={`${t.dir}-${t.id}`} className={`bubble ${t.dir}`}>
                <div className="muted">{when(t.at)}</div>
                <div>{t.text}</div>
              </div>
            ))}
            {convo.data && !convo.data.transcript.length && <Empty>No messages yet.</Empty>}
          </div>
          <Field label="Your reply">
            <Textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type your reply to this person…" />
          </Field>
          <Button disabled={!draft.trim() || send.isPending} onClick={() => run(async () => { await send.mutateAsync({ phone: c.uid, text: draft }); setDraft(""); })}>Send reply</Button>
        </>}
      </Card>
    ))}
  </>;
}

// ---------------------------------------------------------------- shell

export function PromotionDesk({ onSwitchToFull }: { onSwitchToFull: (() => void) | null }) {
  const { signOut } = useMe();
  const [screen, setScreen] = useState<Screen>(() => {
    try { return (localStorage.getItem(SCREEN_KEY) as Screen) || "today"; } catch { return "today"; }
  });
  const [outcome, setOutcome] = useState<string | undefined>();
  useEffect(() => { try { localStorage.setItem(SCREEN_KEY, screen); } catch { /* per-viewer convenience only */ } }, [screen]);
  const me = trpc.promotion.me.useQuery();
  const facetsQ = trpc.promotion.filters.useQuery({});
  const cfg = trpc.public.config.useQuery(undefined, { staleTime: 60_000 });
  const go = (s: Screen, o?: string) => { setOutcome(o); setScreen(s); };
  return <div className="desk-shell">
    <header className="desk-top">
      <div className="desk-brand"><Brand lockup="horizontal" height={26} /><span className="desk-brand-name">Promotion desk</span></div>
      <nav className="desk-nav">{SCREENS.map(([s, label]) => (
        <button key={s} className={screen === s ? "on" : ""} onClick={() => go(s)}>{label}</button>
      ))}</nav>
      <div className="desk-who">
        {cfg.data?.sampleData && <Badge tone="warning">Sample data</Badge>}
        <span>{me.data?.name ?? ""}{me.data?.isAssistant ? " · assistant" : ""}</span>
        {onSwitchToFull && <Button size="sm" variant="ghost" onClick={onSwitchToFull}>Technical view</Button>}
        <Button size="sm" variant="ghost" onClick={signOut}>Sign out</Button>
      </div>
    </header>
    <main className="desk-main">
      {screen === "today" && <Today onGo={go} />}
      {screen === "entries" && <Entries facets={facetsQ.data ?? undefined} canDecide={!!me.data?.canDecideEntries} />}
      {screen === "submissions" && <Submissions facets={facetsQ.data ?? undefined} initialOutcome={outcome} />}
      {screen === "queries" && <Queries />}
    </main>
  </div>;
}
export { session };

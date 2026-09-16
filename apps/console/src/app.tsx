import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, makeClient, session } from "./lib/trpc.ts";
import { AuthProvider, useMe, useCan, type Me, type Permission } from "./lib/auth.tsx";
import { usePath, match, Link, navigate } from "./lib/router.tsx";
import { ToastProvider, Button, Loading, Brand } from "./ui/kit.tsx";
import { LoginPage } from "./pages/login.tsx";
import { AccountPage } from "./pages/account.tsx";
import { OverviewPage } from "./pages/overview.tsx";
import { CampaignsPage, CampaignDetailPage } from "./pages/campaigns.tsx";
import { MasterDataPage } from "./pages/master-data.tsx";
import { ParticipantsPage, ParticipantDetailPage } from "./pages/participants.tsx";
import { SubmissionsPage, SubmissionDetailPage } from "./pages/submissions.tsx";
import { EntriesPage, EntryDetailPage } from "./pages/entries.tsx";
import { DrawsPage, DrawDetailPage } from "./pages/draws.tsx";
import { WinnersPage, WinnerDetailPage } from "./pages/winners.tsx";
import { SupportPage } from "./pages/support.tsx";
import { OpsPage } from "./pages/ops.tsx";
import { StaffPage } from "./pages/staff.tsx";
import { AuditPage } from "./pages/audit.tsx";
import { ReadinessPage } from "./pages/readiness.tsx";
import { SimulatorPage } from "./pages/simulator.tsx";
import { PromotionDesk } from "./promotion/Desk.tsx";

type NavItem = { to: string; label: string; perm?: Permission; match?: string[] };
const NAV: Array<{ group: string; items: NavItem[] }> = [
  { group: "Operate", items: [{ to: "/", label: "Overview", perm: "report.read" }, { to: "/submissions", label: "Submissions & review", perm: "submission.read" }, { to: "/entries", label: "Entries", perm: "entry.read" }, { to: "/participants", label: "Participants", perm: "participant.read" }, { to: "/support", label: "Support", perm: "support.read" }] },
  { group: "Draws & prizes", items: [{ to: "/draws", label: "Draws", perm: "draw.read" }, { to: "/winners", label: "Winners & claims", perm: "winner.read" }] },
  { group: "Configure", items: [{ to: "/campaigns", label: "Campaigns", perm: "campaign.read" }, { to: "/master-data", label: "Outlets & products", perm: "campaign.read" }, { to: "/simulator", label: "Simulator", perm: "simulator.use" }] },
  { group: "Platform", items: [{ to: "/ops", label: "Integrations & queues", perm: "ops.read" }, { to: "/audit", label: "Audit log", perm: "audit.read" }, { to: "/staff", label: "Access", perm: "staff.manage" }, { to: "/readiness", label: "Readiness" }, { to: "/account", label: "My account" }] },
];

function Shell({ children }: { children: React.ReactNode }) {
  const { me, signOut } = useMe(); const can = useCan(); const path = usePath().split("?")[0]; const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [path]);
  const cfg = trpc.public.config.useQuery(undefined, { staleTime: 60_000 });
  return <div className="tt-shell">
    {open && <div className="tt-scrim" onClick={() => setOpen(false)} />}
    <aside className={`tt-sidebar ${open ? "open" : ""}`}>
      <div className="tt-brand"><Brand lockup="horizontal" height={26} /></div>
      <nav className="tt-nav">{NAV.map((g) => { const items = g.items.filter((i) => !i.perm || can(i.perm)); if (!items.length) return null; return <div key={g.group}><div className="tt-nav-group">{g.group}</div>{items.map((i) => <Link key={i.to} to={i.to} className={(i.to === "/" ? path === "/" : path.startsWith(i.to)) ? "active" : ""}>{i.label}</Link>)}</div>; })}</nav>
      <div style={{ marginTop: "auto", padding: 8 }} className="small muted">{me?.name}<br />{me?.roles.join(", ")}</div>
    </aside>
    <div className="tt-main">
      <header className="tt-topbar">
        <Button className="tt-menu-btn" size="sm" onClick={() => setOpen(true)} aria-label="Open menu">☰</Button>
        <span className={`tt-env ${me?.environment ?? ""}`}>{me?.environment}</span>
        {cfg.data?.sampleData && <span className="badge warning">Sample data</span>}
        {cfg.data && cfg.data.transport !== "configured" && <span className="badge warning">WhatsApp simulated</span>}
        <span className="spacer" />
        <span className="small muted">{me?.email}</span>
        <Button size="sm" onClick={() => void signOut()}>Sign out</Button>
      </header>
      <main className="tt-content">{children}</main>
    </div>
  </div>;
}

/** Roles that mean "the client's promotion team", as opposed to the platform team. */
const PROMOTION_ROLES = ["promotion_admin", "promotion_assistant"];
/** Roles that mean "the platform team" — anyone holding one can reach the technical console. */
const TECHNICAL_ROLES = ["campaign_manager", "reviewer", "draw_officer", "draw_approver", "fulfilment", "auditor", "platform_admin", "support"];

function Routes() {
  const full = usePath(); const path = full.split("?")[0]; const { me } = useMe();
  const [forceFull, setForceFull] = useState(false);
  // A temporary password must be changed before anything else is reachable.
  //
  // This redirect HAS to happen in an effect rather than during render. navigate()
  // dispatches `tt:navigate` synchronously, and on the very first render usePath's
  // addEventListener effect has not run yet — so the event reached no listener, the
  // URL changed, the component returned null, and nothing ever re-rendered. Every
  // staff member's first sign-in, with the temporary password they were issued,
  // landed on a permanently blank console. It only looked fine when /account was
  // opened directly, because then the guard never fired.
  const needsPasswordChange = !!me?.mustChangePassword;
  const onAccount = path === "/account";
  useEffect(() => { if (needsPasswordChange && !onAccount) navigate("/account?mustChange=1", { replace: true }); }, [needsPasswordChange, onAccount]);
  if (!me) return <LoginPage />;
  // The password gate outranks console selection, and is keyed on the FLAG rather
  // than on the path: keying it on `path !== "/account"` made it go false the
  // moment the redirect landed, so a promotion user fell straight through to the
  // desk and every one of its queries failed with PASSWORD_CHANGE_REQUIRED.
  // Rendered immediately rather than waiting for the effect, so there is no blank
  // frame even for one paint.
  if (needsPasswordChange) return <Shell><AccountPage /></Shell>;
  // Which console a person gets is decided by the roles on their account, not by
  // a setting they could lose. Someone who ALSO holds a technical role (a
  // platform engineer sitting with the client, say) can switch to the full
  // console, because taking the technical surface away from someone who needs it
  // would be worse than offering a client-facing one they can ignore.
  const promotion = me.roles.some((r) => PROMOTION_ROLES.includes(r));
  const technical = me.roles.some((r) => TECHNICAL_ROLES.includes(r));
  if (promotion && !forceFull) return <PromotionDesk onSwitchToFull={technical ? () => setForceFull(true) : null} />;
  let page: React.ReactNode = null; let p: Record<string, string> | null;
  if (path === "/" ) page = <OverviewPage />;
  else if (path === "/account") page = <AccountPage />;
  else if (path === "/campaigns") page = <CampaignsPage />;
  else if ((p = match("/campaigns/:id", path))) page = <CampaignDetailPage id={p.id} />;
  else if (path === "/master-data") page = <MasterDataPage />;
  else if (path === "/participants") page = <ParticipantsPage />;
  else if ((p = match("/participants/:id", path))) page = <ParticipantDetailPage id={p.id} />;
  else if (path === "/submissions") page = <SubmissionsPage />;
  else if ((p = match("/submissions/:id", path))) page = <SubmissionDetailPage id={p.id} />;
  else if (path === "/entries") page = <EntriesPage />;
  else if ((p = match("/entries/:id", path))) page = <EntryDetailPage id={p.id} />;
  else if (path === "/draws") page = <DrawsPage />;
  else if ((p = match("/draws/:id", path))) page = <DrawDetailPage id={p.id} />;
  else if (path === "/winners") page = <WinnersPage />;
  else if ((p = match("/winners/:id", path))) page = <WinnerDetailPage id={p.id} />;
  else if (path === "/support") page = <SupportPage />;
  else if (path === "/ops") page = <OpsPage />;
  else if (path === "/staff") page = <StaffPage />;
  else if (path === "/audit") page = <AuditPage />;
  else if (path === "/readiness") page = <ReadinessPage />;
  else if (path === "/simulator") page = <SimulatorPage />;
  else page = <div className="empty">Page not found. <Link to="/">Go to the overview</Link></div>;
  return <Shell>{page}</Shell>;
}

function Session({ children }: { children: (v: { me: Me | null; refresh: () => Promise<unknown>; signOut: () => Promise<void> }) => React.ReactNode }) {
  const utils = trpc.useUtils(); const [tick, setTick] = useState(0);
  const me = trpc.auth.me.useQuery(undefined, { enabled: !!session.token, retry: false, staleTime: 30_000 });
  const logout = trpc.auth.logout.useMutation();
  useEffect(() => { if (me.error && (me.error.data?.httpStatus === 401)) { session.set(null); setTick((t) => t + 1); } }, [me.error]);
  const value = useMemo(() => ({ me: session.token && me.data ? (me.data as Me) : null, refresh: async () => { await utils.auth.me.invalidate(); setTick((t) => t + 1); }, signOut: async () => { try { await logout.mutateAsync(); } catch { /* token may already be gone */ } session.set(null); utils.invalidate(); setTick((t) => t + 1); navigate("/"); } }), [me.data, tick, utils, logout]);
  if (session.token && me.isLoading) return <Loading label="Signing in" />;
  return <>{children(value)}</>;
}

export function App() {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }));
  const [client] = useState(() => makeClient());
  return <trpc.Provider client={client} queryClient={qc}><QueryClientProvider client={qc}><ToastProvider><Session>{(v) => <AuthProvider value={v}><Routes /></AuthProvider>}</Session></ToastProvider></QueryClientProvider></trpc.Provider>;
}

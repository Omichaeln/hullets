import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, makeClient, session } from "./lib/trpc.ts";
import { AuthProvider, useMe, useCan, type Me, type Permission } from "./lib/auth.tsx";
import { usePath, match, Link, navigate } from "./lib/router.tsx";
import { ToastProvider, Loading, Brand, Menu } from "./ui/kit.tsx";
import { getTheme, applyTheme, THEMES, type Theme } from "./lib/theme.ts";
import { titleCase } from "./lib/format.ts";
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
import { SettingsPage } from "./pages/settings.tsx";
import { PromotionDesk } from "./promotion/Desk.tsx";

type NavItem = { to: string; label: string; perm?: Permission };
/**
 * Navigation, grouped by the kind of work and the cadence it happens at rather
 * than by what the code underneath is called:
 *
 *   Run        the day's work — what came in, what it earned, who is asking
 *   Draws      the periodic ceremony, under separation of duties
 *   Set up     done before launch and between waves by the campaign manager
 *   Administer housekeeping a platform administrator does occasionally
 *   System     what an engineer reads to know the installation is healthy
 *
 * The person's own things — account, theme, sign-out — are not navigation at all;
 * they live on the person, in the topbar menu.
 */
const NAV: Array<{ group: string; items: NavItem[] }> = [
  { group: "Run", items: [{ to: "/", label: "Overview", perm: "report.read" }, { to: "/submissions", label: "Submissions & review", perm: "submission.read" }, { to: "/entries", label: "Entries", perm: "entry.read" }, { to: "/participants", label: "Participants", perm: "participant.read" }, { to: "/support", label: "Support", perm: "support.read" }] },
  { group: "Draws", items: [{ to: "/draws", label: "Draws", perm: "draw.read" }, { to: "/winners", label: "Winners & claims", perm: "winner.read" }] },
  { group: "Set up", items: [{ to: "/campaigns", label: "Campaigns", perm: "campaign.read" }, { to: "/master-data", label: "Outlets & products", perm: "campaign.read" }, { to: "/simulator", label: "Simulator", perm: "simulator.use" }] },
  { group: "Administer", items: [{ to: "/staff", label: "Access", perm: "staff.manage" }, { to: "/settings", label: "Settings", perm: "settings.write" }] },
  { group: "System", items: [{ to: "/ops", label: "Integrations & queues", perm: "ops.read" }, { to: "/audit", label: "Audit log", perm: "audit.read" }, { to: "/readiness", label: "Readiness" }] },
];
/** One small stroke icon per destination, so the collapsed rail still reads. */
const ICON: Record<string, string> = {
  "/": "M3 11l9-8 9 8M5 10v10h14V10",
  "/submissions": "M6 3h9l4 4v14H6zM14 3v5h5M9 12h6M9 16h6",
  "/entries": "M4 7h16v10H4zM9 12l2 2 4-4",
  "/participants": "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0",
  "/support": "M5 12a7 7 0 0 1 14 0M5 12v4a2 2 0 0 0 2 2h2v-6H5zM19 12v4a2 2 0 0 1-2 2h-2v-6h4",
  "/draws": "M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.3 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z",
  "/winners": "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3",
  "/campaigns": "M4 5h16v14H4zM4 10h16M9 5v14",
  "/master-data": "M3 10l9-6 9 6v10H3zM9 20v-6h6v6",
  "/simulator": "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 18h2",
  "/staff": "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1",
  "/settings": "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1",
  "/ops": "M6 3v6a6 6 0 0 0 12 0V3M9 3v4M15 3v4M12 15v6",
  "/audit": "M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7z",
  "/readiness": "M20 6L9 17l-5-5",
};
const Icon = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const SIDEBAR_KEY = "hullets.sidebar";

function Shell({ children }: { children: React.ReactNode }) {
  const { me, signOut } = useMe(); const can = useCan(); const path = usePath().split("?")[0];
  // Two independent things that the old single `open` flag conflated: the phone
  // DRAWER (transient, closes on navigation) and the desktop RAIL (a preference,
  // remembered per browser).
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(SIDEBAR_KEY) === "rail"; } catch { return false; } });
  useEffect(() => { setDrawer(false); }, [path]);
  useEffect(() => { try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "rail" : "full"); } catch { /* per-viewer convenience only */ } }, [collapsed]);
  const [theme, setTheme] = useState<Theme>(getTheme);
  const chooseTheme = (t: Theme) => { applyTheme(t); setTheme(t); };
  const cfg = trpc.public.config.useQuery(undefined, { staleTime: 60_000 });
  const initials = (me?.name ?? "?").split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const roles = (me?.roles ?? []).map(titleCase).join(", ");
  return <div className="tt-shell" data-collapsed={collapsed ? "true" : "false"}>
    <div className={`tt-scrim ${drawer ? "on" : ""}`} onClick={() => setDrawer(false)} aria-hidden="true" />
    <aside className={`tt-sidebar ${drawer ? "open" : ""}`} aria-label="Navigation">
      <div className="tt-brand">
        {collapsed ? <Brand lockup="icon" height={28} /> : <Brand lockup="horizontal" height={26} />}
        <button type="button" className="tt-fold" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} title={collapsed ? "Expand" : "Collapse"}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={collapsed ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"} /></svg>
        </button>
        <button type="button" className="tt-fold tt-fold-close" onClick={() => setDrawer(false)} aria-label="Close menu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <nav className="tt-nav" aria-label="Primary">{NAV.map((g) => {
        const items = g.items.filter((i) => !i.perm || can(i.perm)); if (!items.length) return null;
        return <div key={g.group}><div className="tt-nav-group">{g.group}</div>{items.map((i) => {
          const active = i.to === "/" ? path === "/" : path.startsWith(i.to);
          return <Link key={i.to} to={i.to} className={active ? "active" : ""} title={collapsed ? i.label : undefined} aria-current={active ? "page" : undefined}><Icon d={ICON[i.to]} /><span className="label">{i.label}</span></Link>;
        })}</div>;
      })}</nav>
    </aside>
    <div className="tt-main">
      <header className="tt-topbar">
        <button type="button" className="tt-menu-btn" onClick={() => setDrawer(true)} aria-label="Open menu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
        <span className={`tt-env ${me?.environment ?? ""}`}>{me?.environment}</span>
        {cfg.data?.sampleData && <span className="badge warning">Sample data</span>}
        {cfg.data && cfg.data.transport !== "configured" && <span className="badge warning">WhatsApp simulated</span>}
        <span className="spacer" />
        <Menu align="right" label={<span className="tt-user"><span className="tt-avatar" aria-hidden="true">{initials}</span><span className="tt-user-name"><span>{me?.name}</span><small>{roles}</small></span></span>}>
          <div className="tt-menu-head"><strong>{me?.name}</strong><div className="small muted">{me?.email}</div><div className="small muted">{roles}</div></div>
          <Link to="/account" className="tt-menu-item">My account<span className="small muted">password · two-step</span></Link>
          <div className="tt-menu-item static"><span>Theme</span><div className="tt-seg" role="radiogroup" aria-label="Theme">{THEMES.map(([t, l]) => <button key={t} type="button" role="radio" aria-checked={theme === t} className={theme === t ? "on" : ""} onClick={() => chooseTheme(t)}>{l}</button>)}</div></div>
          <button type="button" className="tt-menu-item danger" onClick={() => void signOut()}>Sign out</button>
        </Menu>
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
  else if (path === "/settings") page = <SettingsPage />;
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

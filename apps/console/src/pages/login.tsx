import { useState } from "react";
import { trpc, session, errorMessage } from "../lib/trpc.ts";
import { useMe } from "../lib/auth.tsx";
import { Button, Card, Field, Input, Callout, Brand } from "../ui/kit.tsx";
export function LoginPage() {
  const { refresh } = useMe(); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [code, setCode] = useState(""); const [mfaUser, setMfaUser] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const login = trpc.auth.login.useMutation(); const verify = trpc.auth.verifyMfa.useMutation(); const cfg = trpc.public.config.useQuery();
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setErr(null); try { if (mfaUser) { const r = await verify.mutateAsync({ userId: mfaUser, code }); session.set(r.token); await refresh(); return; } const r = await login.mutateAsync({ email, password }); if (r.pendingMfa) { setMfaUser(r.userId ?? null); return; } session.set(r.token); await refresh(); } catch (e2) { setErr(errorMessage(e2)); } };
  return <div className="login-wrap"><img className="login-wave on-light" src="/brand/huletts-wave.svg" alt="" aria-hidden="true" /><img className="login-wave on-dark" src="/brand/huletts-wave-reverse.svg" alt="" aria-hidden="true" /><div className="login tt-stack">
    <div className="tt-brand" style={{ justifyContent: "center" }}><Brand lockup="vertical" height={78} /></div>
    <Card title={mfaUser ? "Two-step verification" : "Staff sign in"}>
      <form onSubmit={submit} className="tt-col">
        {cfg.data && <div className="tt-row"><span className={`tt-env ${cfg.data.environment}`}>{cfg.data.environment}</span>{cfg.data.sampleData && <span className="badge warning">Sample data</span>}</div>}
        {!mfaUser ? <><Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field></>
          : <Field label="Authenticator code" help="Six digits from your authenticator app."><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required /></Field>}
        {err && <Callout tone="danger">{err}</Callout>}
        <Button variant="primary" size="lg" className="block" type="submit" loading={login.isPending || verify.isPending}>{mfaUser ? "Verify" : "Sign in"}</Button>
        {mfaUser && <Button variant="ghost" type="button" onClick={() => { setMfaUser(null); setCode(""); }}>Back</Button>}
      </form>
    </Card>
    <p className="small muted" style={{ textAlign: "center" }}>Access is restricted to authorised campaign staff. Every action is recorded in the audit log.</p>
  </div></div>;
}

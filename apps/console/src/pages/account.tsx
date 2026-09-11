import { useState } from "react";
import { trpc, errorMessage } from "../lib/trpc.ts";
import { useMe } from "../lib/auth.tsx";
import { useQueryParams } from "../lib/router.tsx";
import { PageHead, Card, Field, Input, Button, Callout, KV, useToast } from "../ui/kit.tsx";
export function AccountPage() {
  const { me, refresh } = useMe(); const q = useQueryParams(); const toast = useToast();
  const [cur, setCur] = useState(""); const [nw, setNw] = useState(""); const [nw2, setNw2] = useState(""); const [err, setErr] = useState<string | null>(null);
  const change = trpc.auth.changePassword.useMutation(); const enroll = trpc.auth.mfaEnroll.useMutation(); const enable = trpc.auth.mfaEnable.useMutation(); const disable = trpc.auth.mfaDisable.useMutation();
  const [enrol, setEnrol] = useState<{ secret: string; otpauth: string } | null>(null); const [code, setCode] = useState("");
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setErr(null); if (nw !== nw2) { setErr("The new passwords do not match."); return; } try { await change.mutateAsync({ currentPassword: cur, newPassword: nw }); toast.push("Password changed", "success"); setCur(""); setNw(""); setNw2(""); await refresh(); } catch (e2) { setErr(errorMessage(e2)); } };
  return <>
    <PageHead title="My account" sub={me?.email} />
    {q.get("mustChange") && <Callout tone="warning">Your temporary password must be changed before you can use the console.</Callout>}
    <div className="tt-grid c2" style={{ marginTop: 16 }}>
      <Card title="Change password">
        <form onSubmit={submit} className="tt-col">
          <Field label="Current password"><Input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></Field>
          <Field label="New password" help="At least 14 characters with lower case plus upper case or digits."><Input type="password" autoComplete="new-password" value={nw} onChange={(e) => setNw(e.target.value)} required minLength={14} /></Field>
          <Field label="Repeat new password"><Input type="password" autoComplete="new-password" value={nw2} onChange={(e) => setNw2(e.target.value)} required /></Field>
          {err && <Callout tone="danger">{err}</Callout>}
          <div><Button variant="primary" type="submit" loading={change.isPending}>Change password</Button></div>
        </form>
      </Card>
      <Card title="Two-step verification (TOTP)">
        <KV rows={[["Status", me?.mfaEnabled ? "Enabled" : "Not enabled"], ["Roles", me?.roles.join(", ")]]} />
        {!me?.mfaEnabled && !enrol && <div style={{ marginTop: 12 }}><Button onClick={async () => { try { setEnrol(await enroll.mutateAsync()); } catch (e) { toast.push(errorMessage(e), "error"); } }} loading={enroll.isPending}>Set up authenticator</Button></div>}
        {enrol && <div className="tt-col" style={{ marginTop: 12 }}>
          <p className="small">Add this secret to your authenticator app (or use the URI), then enter the current code.</p>
          <pre>{enrol.secret}</pre><pre className="small">{enrol.otpauth}</pre>
          <Field label="Code"><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <div className="tt-row"><Button variant="primary" loading={enable.isPending} onClick={async () => { try { await enable.mutateAsync({ code }); setEnrol(null); setCode(""); toast.push("Two-step verification enabled", "success"); await refresh(); } catch (e) { toast.push(errorMessage(e), "error"); } }}>Enable</Button><Button variant="ghost" onClick={() => setEnrol(null)}>Cancel</Button></div>
        </div>}
        {me?.mfaEnabled && <div className="tt-col" style={{ marginTop: 12 }}><Field label="Disable with a current code"><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} /></Field><div><Button variant="danger" loading={disable.isPending} onClick={async () => { try { await disable.mutateAsync({ code }); setCode(""); toast.push("Two-step verification disabled", "success"); await refresh(); } catch (e) { toast.push(errorMessage(e), "error"); } }}>Disable</Button></div></div>}
      </Card>
    </div>
  </>;
}

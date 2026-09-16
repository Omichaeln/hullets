import { createContext, useContext, type ReactNode } from "react";
import { can as canRaw, rolesFor, type Permission, type Role } from "@promo/core/auth/policy.ts";
export type Me = { id: string; email: string; name: string; roles: string[]; mfaEnabled: boolean; mustChangePassword: boolean; environment: string };
const Ctx = createContext<{ me: Me | null; refresh: () => Promise<unknown>; signOut: () => Promise<void> }>({ me: null, refresh: async () => undefined, signOut: async () => undefined });
export const AuthProvider = ({ value, children }: { value: { me: Me | null; refresh: () => Promise<unknown>; signOut: () => Promise<void> }; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export const useMe = () => useContext(Ctx);
export function useCan() { const { me } = useContext(Ctx); return (p: Permission) => !!me && canRaw(me.roles, p); }
export type { Permission };

/** How a role is written for a person, as opposed to how it is spelled in the policy. */
export const ROLE_LABELS: Record<Role, string> = { campaign_manager: "Campaign manager", reviewer: "Reviewer", support: "Support", draw_officer: "Draw officer", draw_approver: "Draw approver", fulfilment: "Fulfilment", auditor: "Auditor", platform_admin: "Platform administrator", promotion_admin: "Promotion administrator", promotion_assistant: "Promotion assistant" };
export const roleLabel = (r: string) => ROLE_LABELS[r as Role] ?? r.replace(/_/g, " ");
/** "the Campaign manager role" / "the Draw officer or Draw approver roles" — the roles that may do a thing, in words. */
export function whoCan(p: Permission): string {
  const names = rolesFor(p).filter((r) => !r.startsWith("promotion_")).map(roleLabel);
  if (names.length === 1) return `the ${names[0]} role`;
  return `the ${names.slice(0, -1).join(", ")} or ${names.at(-1)} roles`;
}
/**
 * Says why a control is not on the page, instead of leaving a gap. Renders nothing
 * when the person holds the permission, so it can sit beside the control it explains.
 */
export function Restricted({ perm, action, className }: { perm: Permission; action: string; className?: string }) {
  const can = useCan(); if (can(perm)) return null;
  return <span className={`tt-restricted ${className ?? ""}`} role="note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg><span>{action} needs {whoCan(perm)}.</span></span>;
}

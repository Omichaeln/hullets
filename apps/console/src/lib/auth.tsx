import { createContext, useContext, type ReactNode } from "react";
import { can as canRaw, type Permission } from "@promo/core/auth/policy.ts";
export type Me = { id: string; email: string; name: string; roles: string[]; mfaEnabled: boolean; mustChangePassword: boolean; environment: string };
const Ctx = createContext<{ me: Me | null; refresh: () => Promise<unknown>; signOut: () => Promise<void> }>({ me: null, refresh: async () => undefined, signOut: async () => undefined });
export const AuthProvider = ({ value, children }: { value: { me: Me | null; refresh: () => Promise<unknown>; signOut: () => Promise<void> }; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export const useMe = () => useContext(Ctx);
export function useCan() { const { me } = useContext(Ctx); return (p: Permission) => !!me && canRaw(me.roles, p); }
export type { Permission };

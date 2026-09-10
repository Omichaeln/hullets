import { useEffect, useState, useId, isValidElement, cloneElement, type ReactNode, createContext, useContext, useCallback, useRef } from "react";
import { STATUS_TONE, titleCase } from "../lib/format.ts";
import { authFetch } from "../lib/trpc.ts";
export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) { return <div className="tt-page-head"><div><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>{actions && <div className="actions">{actions}</div>}</div>; }
export function Card({ title, actions, children, flush, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) { return <section className={`tt-card ${className ?? ""}`}>{(title || actions) && <div className="head">{typeof title === "string" ? <h2>{title}</h2> : title}{actions && <div className="actions">{actions}</div>}</div>}<div className={`body ${flush ? "flush" : ""}`}>{children}</div></section>; }
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) { return <div className="tt-card tt-stat"><div className="label">{label}</div><div className="value">{value}</div>{hint && <div className="hint">{hint}</div>}</div>; }
export function Button({ variant, size, loading, children, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost"; size?: "sm" | "lg"; loading?: boolean }) { return <button className={`btn ${variant ?? ""} ${size ?? ""} ${className ?? ""}`} disabled={loading || rest.disabled} {...rest}>{loading && <span className="spinner" style={{ width: 12, height: 12 }} />}{children}</button>; }
export function Badge({ tone, children, status }: { tone?: "success" | "warning" | "danger" | "info" | "primary"; children?: ReactNode; status?: string | null }) { const t = tone ?? (status ? STATUS_TONE[status] : undefined); return <span className={`badge ${t ?? ""}`}>{children ?? titleCase(status)}</span>; }
/** Labelled control: a single input/select/textarea child gets an id so the label is associated (accessibility, test selectors). */
export function Field({ label, help, error, children }: { label: ReactNode; help?: ReactNode; error?: ReactNode; children: ReactNode }) {
  const id = useId(); const single = isValidElement(children) && typeof children.type !== "string" && !(children.props as { id?: string }).id;
  const control = single ? cloneElement(children as React.ReactElement<{ id?: string }>, { id }) : children;
  return <div className="field"><label htmlFor={single ? id : undefined}>{label}</label>{control}{help && <div className="help">{help}</div>}{error && <div className="error">{error}</div>}</div>;
}
export function Input(props: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) { const { mono, className, ...rest } = props; return <input className={`input ${mono ? "mono" : ""} ${className ?? ""}`} {...rest} />; }
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) { const { className, ...rest } = props; return <select className={`select ${className ?? ""}`} {...rest} />; }
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) { const { mono, className, ...rest } = props; return <textarea className={`textarea ${mono ? "mono" : ""} ${className ?? ""}`} {...rest} />; }
export function Checkbox({ label, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) { return <label className="checkbox"><input type="checkbox" {...rest} /><span>{label}</span></label>; }
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (t: T) => void }) { return <div className="tabs" role="tablist">{tabs.map((t) => <button key={t.id} role="tab" aria-selected={t.id === value} className={t.id === value ? "active" : ""} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>; }
export function KV({ rows }: { rows: Array<[ReactNode, ReactNode]> }) { return <dl className="kv">{rows.map(([k, v], i) => <div key={i} style={{ display: "contents" }}><dt>{k}</dt><dd>{v ?? "–"}</dd></div>)}</dl>; }
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
export function Loading({ label = "Loading" }: { label?: string }) { return <div className="empty"><span className="spinner" /> <span className="sr-only">{label}</span></div>; }
export function ErrorBox({ error }: { error: unknown }) { const e = error as { message?: string }; return <div className="callout danger">{e?.message ?? String(error)}</div>; }
export function Callout({ tone, children }: { tone?: "warning" | "danger" | "success" | "info"; children: ReactNode }) { return <div className={`callout ${tone ?? ""}`}>{children}</div>; }
export function Json({ value }: { value: unknown }) { return <pre>{JSON.stringify(value, null, 2)}</pre>; }
export function Table<T>({ rows, cols, onRow, keyOf, empty = "Nothing to show" }: { rows: T[]; cols: Array<{ h: ReactNode; c: (r: T) => ReactNode; num?: boolean; w?: number | string }>; onRow?: (r: T) => void; keyOf: (r: T) => string; empty?: string }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return <div className="tt-table-wrap"><table className="tt-table"><thead><tr>{cols.map((c, i) => <th key={i} className={c.num ? "num" : ""} style={c.w ? { width: c.w } : undefined}>{c.h}</th>)}</tr></thead><tbody>{rows.map((r) => <tr key={keyOf(r)} className={onRow ? "clickable" : ""} onClick={onRow ? () => onRow(r) : undefined}>{cols.map((c, i) => <td key={i} className={c.num ? "num" : ""}>{c.c(r)}</td>)}</tr>)}</tbody></table></div>;
}
export function Modal({ title, onClose, children, foot, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  return <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="modal" role="dialog" aria-modal="true" style={wide ? { width: "min(960px, 100%)" } : undefined}><div className="head"><h2>{title}</h2><span className="spacer" style={{ flex: 1 }} /><button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button></div><div className="body">{children}</div>{foot && <div className="foot">{foot}</div>}</div></div>;
}
/** Confirm-with-reason dialog used for every consequential action. */
export function ActionDialog({ title, description, confirmLabel = "Confirm", danger, fields, onConfirm, onClose }: { title: string; description?: ReactNode; confirmLabel?: string; danger?: boolean; fields?: Array<{ key: string; label: string; type?: "text" | "textarea" | "select" | "number"; options?: Array<{ value: string; label: string }>; required?: boolean; placeholder?: string; help?: string }>; onConfirm: (values: Record<string, string>) => Promise<unknown>; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const toast = useToast();
  const missing = (fields ?? []).filter((f) => f.required && !(values[f.key] ?? "").trim());
  const go = async () => { setBusy(true); setErr(null); try { await onConfirm(values); onClose(); } catch (e) { const m = (e as { message?: string }).message ?? String(e); setErr(m); toast.push(m, "error"); } finally { setBusy(false); } };
  return <Modal title={title} onClose={onClose} foot={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? "danger" : "primary"} loading={busy} disabled={missing.length > 0} onClick={go}>{confirmLabel}</Button></>}>
    {description && <p className="muted">{description}</p>}
    <div className="tt-col">{(fields ?? []).map((f) => <Field key={f.key} label={f.label + (f.required ? " *" : "")} help={f.help}>{f.type === "textarea" ? <Textarea value={values[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} /> : f.type === "select" ? <Select value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}><option value="">Select…</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select> : <Input type={f.type === "number" ? "number" : "text"} value={values[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}</Field>)}</div>
    {err && <div className="callout danger" style={{ marginTop: 12 }}>{err}</div>}
  </Modal>;
}
/* Toasts */
const ToastCtx = createContext<{ push: (m: string, tone?: "error" | "success") => void }>({ push: () => undefined });
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Array<{ id: number; m: string; tone?: string }>>([]); const n = useRef(0);
  const push = useCallback((m: string, tone?: "error" | "success") => { const id = ++n.current; setItems((x) => [...x, { id, m, tone }]); setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), tone === "error" ? 7000 : 3500); }, []);
  return <ToastCtx.Provider value={{ push }}>{children}<div className="toasts" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.tone ?? ""}`}>{t.m}</div>)}</div></ToastCtx.Provider>;
}
/** Image that needs the bearer header (receipt media). */
export function AuthImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let u: string | null = null; let live = true; (async () => { try { const r = await authFetch(src); if (!r.ok) throw new Error(`${r.status}`); const b = await r.blob(); u = URL.createObjectURL(b); if (live) setUrl(u); } catch (e) { if (live) setErr((e as Error).message); } })(); return () => { live = false; if (u) URL.revokeObjectURL(u); }; }, [src]);
  if (err) return <div className="callout warning">Image unavailable ({err})</div>; if (!url) return <Loading label="Loading image" />; return <img src={url} alt={alt} className={className ?? "receipt-img"} />;
}
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) { const [state, set] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true }); useEffect(() => { let live = true; set({ loading: true }); fn().then((data) => live && set({ data, loading: false }), (error) => live && set({ error, loading: false })); return () => { live = false; }; }, deps); return state; }

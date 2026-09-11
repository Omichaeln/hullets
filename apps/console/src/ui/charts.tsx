import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { fmtDate } from "../lib/format.ts";
/**
 * Small, dependency-free charts for the operations pages. One hue for every
 * series (there is one series per chart), status colours only on the
 * availability strip, hairline grid, 2px line, end marker with a surface ring,
 * a crosshair tooltip, keyboard navigation and a table view alongside.
 */
export type Point = { at: string; value: number };
const nice = (max: number) => { if (max <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(max))); const m = max / p; const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10; return step * p; };
const compact = (n: number) => Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${(n / 1e3).toFixed(1)}K` : Number.isInteger(n) ? n.toLocaleString("en-GB") : n.toFixed(1);
const tick = (iso: string, spanMs: number) => { const d = new Date(iso); return spanMs > 2 * 86_400_000 ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); };

export function LineChart({ points, title, unit = "", height = 140, format = compact, empty = "No samples in this range yet." }: { points: Point[]; title: ReactNode; unit?: string; height?: number; format?: (n: number) => string; empty?: string }) {
  const [hover, setHover] = useState<number | null>(null); const box = useRef<HTMLDivElement>(null); const id = useId();
  const W = 640, H = height, PL = 44, PR = 16, PT = 14, PB = 24;
  const g = useMemo(() => {
    if (!points.length) return null; const max = nice(Math.max(...points.map((p) => p.value)) || 0); const t0 = Date.parse(points[0].at), t1 = Date.parse(points[points.length - 1].at); const span = Math.max(1, t1 - t0);
    const x = (t: number) => PL + ((t - t0) / span) * (W - PL - PR); const y = (v: number) => PT + (1 - v / max) * (H - PT - PB);
    const pts = points.map((p) => ({ ...p, x: points.length === 1 ? (PL + W - PR) / 2 : x(Date.parse(p.at)), y: y(p.value) }));
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const area = `${d} L${pts[pts.length - 1].x.toFixed(1)} ${(H - PB).toFixed(1)} L${pts[0].x.toFixed(1)} ${(H - PB).toFixed(1)} Z`;
    return { max, pts, d, area, span, ticks: max >= 2 ? [0, max / 2, max] : [0, max], last: pts[pts.length - 1] };
  }, [points, H]);
  if (!g) return <div className="chart"><h4>{title}</h4><div className="empty small">{empty}</div></div>;
  const pick = (clientX: number) => { const r = box.current?.getBoundingClientRect(); if (!r) return; const px = ((clientX - r.left) / r.width) * W; let best = 0; for (let i = 1; i < g.pts.length; i++) if (Math.abs(g.pts[i].x - px) < Math.abs(g.pts[best].x - px)) best = i; setHover(best); };
  const h = hover != null ? g.pts[hover] : null; const total = points.reduce((a, p) => a + p.value, 0);
  return <div className="chart" ref={box}>
    <div className="chart-head"><h4 id={`${id}-t`}>{title}</h4><span className="small muted">{unit === "count" ? `${compact(total)} in range` : `max ${format(g.max)}${unit ? ` ${unit}` : ""}`}</span></div>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} tabIndex={0} className="chart-svg"
      onMouseMove={(e) => pick(e.clientX)} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}
      onKeyDown={(e) => { if (e.key === "ArrowRight") { e.preventDefault(); setHover((i) => Math.min(g.pts.length - 1, (i ?? -1) + 1)); } if (e.key === "ArrowLeft") { e.preventDefault(); setHover((i) => Math.max(0, (i ?? g.pts.length) - 1)); } if (e.key === "Escape") setHover(null); }}>
      {g.ticks.map((t, i) => { const y = PT + (1 - t / g.max) * (H - PT - PB); return <g key={i}><line x1={PL} x2={W - PR} y1={y} y2={y} className="chart-grid" /><text x={PL - 6} y={y + 4} textAnchor="end" className="chart-tick">{format(t)}</text></g>; })}
      <text x={PL} y={H - 6} className="chart-tick">{tick(points[0].at, g.span)}</text><text x={W - PR} y={H - 6} textAnchor="end" className="chart-tick">{tick(points[points.length - 1].at, g.span)}</text>
      <path d={g.area} className="chart-area" /><path d={g.d} className="chart-line" />
      {h && <line x1={h.x} x2={h.x} y1={PT} y2={H - PB} className="chart-cross" />}
      {h && <circle cx={h.x} cy={h.y} r={5} className="chart-dot" />}
      {!h && <circle cx={g.last.x} cy={g.last.y} r={4} className="chart-dot" />}
      {!h && <text x={Math.min(g.last.x + 6, W - PR - 30)} y={g.last.y - 8} className="chart-label">{format(g.last.value)}</text>}
    </svg>
    {h && <div className="chart-tip" style={{ left: `${(h.x / W) * 100}%` }} role="status"><strong>{format(h.value)}{unit && unit !== "count" ? ` ${unit}` : ""}</strong><span className="small muted">{fmtDate(h.at)}</span></div>}
  </div>;
}

export type Bucket = { at: string; samples: number; okSamples: number };
/** One cell per bucket: healthy, degraded (some checks failing), down (every sample failing) or no data. Colour plus a symbol, never colour alone. */
export function AvailabilityStrip({ buckets, bucketSec, from, until }: { buckets: Bucket[]; bucketSec: number; from: string; until: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const cells = useMemo(() => { const t0 = Math.floor(Date.parse(from) / (bucketSec * 1000)) * bucketSec * 1000; const t1 = Date.parse(until); const by = new Map(buckets.map((b) => [Math.floor(Date.parse(b.at) / (bucketSec * 1000)) * bucketSec * 1000, b])); const out: Array<{ at: string; state: "ok" | "degraded" | "down" | "none"; b?: Bucket }> = []; for (let t = t0; t <= t1 && out.length < 800; t += bucketSec * 1000) { const b = by.get(t); out.push({ at: new Date(t).toISOString(), b, state: !b || !b.samples ? "none" : b.okSamples === b.samples ? "ok" : b.okSamples === 0 ? "down" : "degraded" }); } return out; }, [buckets, bucketSec, from, until]);
  const c = hover != null ? cells[hover] : null; const word = { ok: "healthy", degraded: "degraded (some checks failing)", down: "down (every sample failing)", none: "no samples" } as const; const sym = { ok: "", degraded: "!", down: "×", none: "" } as const;
  return <div className="avail" onMouseLeave={() => setHover(null)}>
    <div className="avail-strip" role="img" aria-label={`Availability: ${cells.filter((x) => x.state === "ok").length} healthy, ${cells.filter((x) => x.state === "degraded").length} degraded, ${cells.filter((x) => x.state === "down").length} down, ${cells.filter((x) => x.state === "none").length} without samples`}>
      {cells.map((x, i) => <span key={x.at} className={`avail-cell ${x.state}`} onMouseEnter={() => setHover(i)}>{sym[x.state]}</span>)}
    </div>
    <div className="avail-legend small muted"><span><i className="avail-cell ok" /> healthy</span><span><i className="avail-cell degraded">!</i> degraded</span><span><i className="avail-cell down">×</i> down</span><span><i className="avail-cell none" /> no samples</span><span className="grow" />{c ? <span className="ink">{fmtDate(c.at)} · {word[c.state]}{c.b ? ` · ${c.b.okSamples}/${c.b.samples} samples ok` : ""}</span> : <span>{tick(from, 3 * 86_400_000)} → now</span>}</div>
  </div>;
}

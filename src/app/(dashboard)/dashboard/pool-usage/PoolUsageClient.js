"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Badge } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

const RANGES = [
  { id: "today", label: "Today" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
  { id: "60d", label: "60D" },
];

const REFRESH_MS = 20000;
const SLICE_COLORS = ["#3b82f6", "#22c55e", "#a855f7", "#f59e0b", "#06b6d4", "#ec4899"];

// Stable color per slice label so the donut, legend, badges and the recent
// table always agree. Fail is always red, direct is always slate.
function sliceColor(label) {
  if (label === "Fail") return "#ef4444";
  if (label === "direct" || label === "unknown") return "#94a3b8";
  let hash = 0;
  for (const ch of String(label)) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return SLICE_COLORS[hash % SLICE_COLORS.length];
}

const fmt = (n) => Number(n || 0).toLocaleString("en-US");

function fmtPct(n) {
  const v = Number(n || 0);
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`;
}

function timeAgo(iso) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function StatCard({ label, value, hint, accent }) {
  return (
    <Card padding="sm">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tracking-tight tabular-nums", accent || "text-text-main")}>
        {value}
      </p>
      <p className="mt-0.5 text-xs text-text-muted truncate">{hint || "\u00A0"}</p>
    </Card>
  );
}

function PoolBadge({ label }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-text-main">
      <span className="size-2 shrink-0 rounded-full" style={{ background: sliceColor(label) }} />
      {label}
    </span>
  );
}

// Pure helper (module scope): arcs with their dash offsets, so the component
// body never mutates a captured variable during render.
function buildArcs(pools, total, circumference) {
  const arcs = [];
  let offset = 0;
  for (const p of pools) {
    if (p.count <= 0) continue;
    const len = total > 0 ? (p.count / total) * circumference : 0;
    arcs.push({ ...p, len, offset });
    offset += len;
  }
  return arcs;
}

function Donut({ pools, total }) {
  const R = 62;
  const SW = 20;
  const C = 2 * Math.PI * R;
  const arcs = buildArcs(pools, total, C);

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg viewBox="0 0 160 160" className="h-40 w-40 shrink-0">
        <circle
          cx="80" cy="80" r={R} fill="none" strokeWidth={SW}
          stroke="currentColor" className="text-border-subtle" opacity="0.4"
        />
        <g transform="rotate(-90 80 80)">
          {arcs.map((p) => (
            <circle
              key={p.label} cx="80" cy="80" r={R} fill="none" strokeWidth={SW}
              stroke={sliceColor(p.label)} strokeLinecap="butt"
              strokeDasharray={`${p.len} ${Math.max(0, C - p.len)}`}
              strokeDashoffset={-p.offset}
            >
              <title>{`${p.label}: ${fmt(p.count)} (${fmtPct(p.pct)})`}</title>
            </circle>
          ))}
        </g>
        <text x="80" y="77" textAnchor="middle" fontSize="20" fontWeight="600" fill="currentColor" className="text-text-main">
          {fmt(total)}
        </text>
        <text x="80" y="95" textAnchor="middle" fontSize="10" fill="currentColor" className="text-text-muted">
          attempts
        </text>
      </svg>
      <ul className="min-w-[180px] flex-1 space-y-2">
        {pools.length === 0 ? (
          <li className="text-sm text-text-muted">No attempts in this range yet.</li>
        ) : (
          pools.map((p) => (
            <li key={p.label} className="flex items-center gap-2 text-sm">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: sliceColor(p.label) }} />
              <span className="truncate text-text-main">{p.label}</span>
              <span className="ml-auto tabular-nums text-text-muted">{fmt(p.count)}</span>
              <span className="w-14 text-right font-medium tabular-nums text-text-main">{fmtPct(p.pct)}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function RecentTable({ rows }) {
  if (!rows.length) {
    return <p className="py-6 text-center text-sm text-text-muted">No requests in this range yet.</p>;
  }
  return (
    <div className="max-h-[360px] overflow-y-auto custom-scrollbar">
      <table className="w-full text-left text-[12px]">
        <thead className="sticky top-0 bg-surface">
          <tr className="text-[11px] uppercase tracking-wider text-text-muted">
            <th className="py-1.5 pr-2 font-semibold">When</th>
            <th className="py-1.5 pr-2 font-semibold">Model</th>
            <th className="py-1.5 pr-2 font-semibold">Pool</th>
            <th className="py-1.5 pr-2 text-right font-semibold">In</th>
            <th className="py-1.5 pr-2 text-right font-semibold">Cached</th>
            <th className="py-1.5 pr-2 text-right font-semibold">Out</th>
            <th className="py-1.5 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.at}-${i}`} className="border-t border-border-subtle">
              <td className="whitespace-nowrap py-1.5 pr-2 text-text-muted" title={new Date(r.at).toLocaleString()}>
                {timeAgo(r.at)}
              </td>
              <td className="max-w-[220px] truncate py-1.5 pr-2" title={`${r.provider}/${r.model}`}>
                <span className="text-text-muted">{r.provider}/</span>
                <span className="text-text-main">{r.model}</span>
              </td>
              <td className="py-1.5 pr-2"><PoolBadge label={r.pool} /></td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{r.ok ? fmt(r.inTokens) : "—"}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-text-muted">{r.ok ? fmt(r.cachedTokens) : "—"}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{r.ok ? fmt(r.outTokens) : "—"}</td>
              <td className="py-1.5">
                {r.ok
                  ? <Badge variant="success" size="sm">ok</Badge>
                  : <Badge variant="error" size="sm">{r.reason || "fail"}</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MODEL_COLUMNS = [
  { key: "model", label: "Model", align: "left", numeric: false },
  { key: "attempts", label: "Requests", align: "right", numeric: true },
  { key: "fails", label: "Fails", align: "right", numeric: true },
  { key: "failRate", label: "Fail %", align: "right", numeric: true },
  { key: "inTokens", label: "In", align: "right", numeric: true },
  { key: "cachedTokens", label: "Cached", align: "right", numeric: true },
  { key: "outTokens", label: "Out", align: "right", numeric: true },
  { key: "lastAt", label: "Last used", align: "right", numeric: false },
];

function ModelsTable({ models, sort, onSort }) {
  if (!models.length) {
    return <p className="py-6 text-center text-sm text-text-muted">No attempts in this range yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[12px]">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-text-muted">
            {MODEL_COLUMNS.map((col) => {
              const active = sort.key === col.key;
              return (
                <th
                  key={col.key}
                  onClick={() => onSort(col.key)}
                  className={cn(
                    "cursor-pointer select-none py-1.5 pr-2 font-semibold hover:text-text-main",
                    col.align === "right" ? "text-right" : "text-left"
                  )}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {active && (
                      <span className="material-symbols-outlined text-[13px]">
                        {sort.dir === "asc" ? "arrow_upward" : "arrow_downward"}
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
            <th className="py-1.5 font-semibold">Fail reasons</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={`${m.provider}/${m.model}`} className="border-t border-border-subtle">
              <td className="py-1.5 pr-2 whitespace-nowrap">
                <span className="text-text-muted">{m.provider}/</span>
                <span className="font-medium text-text-main">{m.model}</span>
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{fmt(m.attempts)}</td>
              <td className={cn("py-1.5 pr-2 text-right tabular-nums", m.fails > 0 && "font-medium text-red-400")}>
                {fmt(m.fails)}
              </td>
              <td className={cn("py-1.5 pr-2 text-right tabular-nums", m.fails > 0 && "text-red-400")}>
                {fmtPct(m.failRate)}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{fmt(m.inTokens)}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-text-muted">{fmt(m.cachedTokens)}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{fmt(m.outTokens)}</td>
              <td className="py-1.5 pr-2 text-right text-text-muted" title={m.lastAt ? new Date(m.lastAt).toLocaleString() : ""}>
                {m.lastAt ? timeAgo(m.lastAt) : "—"}
              </td>
              <td className="py-1.5">
                <span className="flex flex-wrap gap-1">
                  {m.reasons.length === 0 ? (
                    <span className="text-text-muted">—</span>
                  ) : (
                    m.reasons.slice(0, 4).map((r) => (
                      <Badge key={r.reason} variant="warning" size="sm">{r.reason} ×{r.count}</Badge>
                    ))
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PoolUsageClient() {
  const [range, setRange] = useState("24h");
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [sort, setSort] = useState({ key: "attempts", dir: "desc" });

  // Refetch on mount, on range change and on manual refresh; poll lightly in the
  // background. State updates only happen in async continuations (lint-safe).
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch(`/api/usage-stats?range=${encodeURIComponent(range)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        setData(json);
        setError(null);
        setUpdatedAt(new Date().toISOString());
      } catch (err) {
        if (cancelled) return;
        setError(err?.message || "Failed to load usage stats");
      }
    };
    run();
    const timer = setInterval(run, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [range, refreshKey]);

  const models = useMemo(() => {
    const arr = [...(data?.models || [])];
    const dir = sort.dir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (typeof av === "string" || typeof bv === "string") {
        return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
      }
      return ((av ?? 0) - (bv ?? 0)) * dir;
    });
    return arr;
  }, [data, sort]);

  const handleSort = useCallback((key) => {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "desc" ? "asc" : "desc" };
      const numeric = MODEL_COLUMNS.find((c) => c.key === key)?.numeric;
      return { key, dir: numeric ? "desc" : "asc" };
    });
  }, []);

  const totals = data?.totals;
  const cachedShare = totals?.inTokens > 0 ? (totals.cachedTokens * 100) / totals.inTokens : 0;

  return (
    <div className="space-y-4">
      {/* Toolbar: range selector + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-border-subtle bg-surface p-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                range === r.id ? "bg-primary/10 text-primary" : "text-text-muted hover:text-text-main"
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-muted">
            {updatedAt ? `updated ${timeAgo(updatedAt)}` : error ? "" : "loading…"}
          </span>
          <Button size="sm" variant="outline" icon="refresh" onClick={() => setRefreshKey((k) => k + 1)}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total Requests"
          value={fmt(totals?.attempts)}
          hint={totals ? `${fmt(totals.served)} served · ${fmt(totals.failed)} failed` : ""}
        />
        <StatCard
          label="Input Tokens"
          value={fmt(totals?.inTokens)}
          hint="cache-inclusive"
          accent="text-sky-500"
        />
        <StatCard
          label="Cached Tokens"
          value={fmt(totals?.cachedTokens)}
          hint={totals?.inTokens > 0 ? `${fmtPct(cachedShare)} of input` : ""}
          accent="text-emerald-500"
        />
        <StatCard
          label="Output Tokens"
          value={fmt(totals?.outTokens)}
          hint=""
          accent="text-violet-500"
        />
      </div>

      {/* Pool distribution + recent requests */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[380px_1fr]">
        <Card
          title="Pool distribution"
          subtitle="One slice per upstream call (attempt)"
          icon="donut_large"
          padding="sm"
        >
          <Donut pools={data?.pools || []} total={totals?.attempts || 0} />
        </Card>
        <Card
          title="Recent requests"
          subtitle="Latest upstream calls with the pool that carried them"
          icon="history"
          padding="sm"
        >
          <RecentTable rows={data?.recent || []} />
        </Card>
      </div>

      {/* Per-model table */}
      <Card
        title="Models"
        subtitle="Requests, failures and token usage per model — click a column to sort"
        icon="table_chart"
        padding="sm"
      >
        <ModelsTable models={models} sort={sort} onSort={handleSort} />
      </Card>
    </div>
  );
}

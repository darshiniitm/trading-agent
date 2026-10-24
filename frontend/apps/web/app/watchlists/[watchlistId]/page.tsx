"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { describeApiError } from "@/lib/apiError";
import { newestAsOf, fmtDate, fmtPrice, fmtSignedPct, sinceEntry, type QuoteLike } from "@/lib/watchlistMath";
import { Banner } from "@/ui/Banner";
import { Segmented } from "@/ui/Segmented";
import { Dialog } from "@/ui/Dialog";
import { Button } from "@/ui/Button";
import { Header } from "@/components/watchlist/Header";
import { PromptCard } from "@/components/watchlist/PromptCard";
import { PricesBar } from "@/components/watchlist/PricesBar";
import { KpiRow } from "@/components/watchlist/KpiRow";
import { WatchlistGrid } from "@/components/watchlist/WatchlistGrid";
import { DetailPanel, type DetailEntry } from "@/components/watchlist/DetailPanel";
import { ValidationTiles } from "@/components/watchlist/ValidationTiles";
import { ViewToolbar } from "@/components/watchlist/ViewToolbar";
import { ViewGrid, rowKeyOf } from "@/components/watchlist/ViewGrid";
import { BenchmarkPanel } from "@/components/watchlist/BenchmarkPanel";
import { COLUMNS, VIEW_LABELS, visibleColumns, type DataView } from "@/components/watchlist/columns";
import type { Tf, ViewId, ViewRow, ViewsPayload } from "@/components/watchlist/viewTypes";
import { buildViewCsv } from "@/lib/viewCsv";
import type { Currency } from "@/lib/viewFormat";
import styles from "@/components/watchlist/watchlist.module.css";

type Tab = "all" | "full_match" | "near_miss" | "rejected_risk_cap";

async function getJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json();
  if (!res.ok) throw new Error(describeApiError(body, "request failed"));
  return body;
}
const postJson = (url: string, data: unknown) => getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

function WatchlistScreen({ watchlistId }: { watchlistId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const qc = useQueryClient();
  const entryParam = search.get("entry");
  const notice = search.get("notice");
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [cooling, setCooling] = useState(false);
  const [dry, setDry] = useState<{ open: boolean; busy: boolean; result?: any; error?: string }>({ open: false, busy: false });
  const lastGood = useRef<Record<string, QuoteLike>>({});
  // P6 view state. Hydrated once from the saved per-user prefs; every change is saved back (best effort).
  const [viewId, setViewId] = useState<ViewId>("screen");
  const [tf, setTf] = useState<Tf>("1D");
  const [ccy, setCcy] = useState<Currency>("INR");
  const [compact, setCompact] = useState(false);
  const [hiddenCols, setHiddenCols] = useState<Record<string, string[]>>({});
  const [refreshingMetrics, setRefreshingMetrics] = useState(false);
  const prefsHydrated = useRef(false);

  const viewQ = useQuery({ queryKey: ["watchlist", watchlistId], queryFn: () => getJson(`/api/watchlists/${watchlistId}`) });
  const view = viewQ.data as any;
  const entries: any[] = useMemo(() => (view?.entries ?? []).filter((e: any) => e.status !== "removed_by_user"), [view]);
  const symbols = useMemo(() => entries.map((e) => e.symbol), [entries]);

  const quotesQ = useQuery({
    queryKey: ["quotes", symbols.join(",")], enabled: symbols.length > 0, staleTime: 60_000,
    queryFn: () => postJson("/api/quotes", { symbols }) as Promise<Record<string, QuoteLike>>,
  });
  const closesQ = useQuery({
    queryKey: ["closes", symbols.join(",")], enabled: symbols.length > 0,
    queryFn: () => postJson("/api/series/closes", { symbols, weeks: 12 }) as Promise<Record<string, number[]>>,
  });
  const healthQ = useQuery({ queryKey: ["health"], queryFn: () => getJson("/api/health"), retry: false });
  // One call returns every view group, so switching views never refetches; only a new technicals timeframe does.
  const viewsQ = useQuery({
    queryKey: ["views", watchlistId, tf], staleTime: 60_000, retry: false, placeholderData: (prev) => prev,
    queryFn: () => getJson(`/api/watchlists/${watchlistId}/views?tf=${tf}`) as Promise<ViewsPayload>,
  });
  const views = viewsQ.data && Array.isArray(viewsQ.data.sections) ? viewsQ.data : null;
  useEffect(() => {
    if (!views?.prefs || prefsHydrated.current) return;
    prefsHydrated.current = true;
    setViewId(views.prefs.view); setCcy(views.prefs.currency); setCompact(views.prefs.compact); setHiddenCols(views.prefs.hiddenColumns ?? {});
    if (views.prefs.techTimeframe !== tf) setTf(views.prefs.techTimeframe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views]);
  function savePrefs(patch: Record<string, unknown>) {
    void fetch(`/api/watchlists/${watchlistId}/view-prefs`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).catch(() => {});
  }
  const changeView = (v: ViewId) => { setViewId(v); savePrefs({ view: v }); };
  const changeCcy = (c: Currency) => { setCcy(c); savePrefs({ currency: c }); };
  const changeTf = (t: Tf) => { setTf(t); savePrefs({ techTimeframe: t }); };
  const changeCompact = (c: boolean) => { setCompact(c); savePrefs({ compact: c }); };
  const changeHidden = (view: DataView, ids: string[]) => { const next = { ...hiddenCols, [view]: ids }; setHiddenCols(next); savePrefs({ hiddenColumns: next }); };
  async function refreshMetrics() {
    setRefreshingMetrics(true);
    try { const fresh = await getJson(`/api/watchlists/${watchlistId}/views?tf=${tf}`, { method: "POST" }); qc.setQueryData(["views", watchlistId, tf], fresh); setStatus("Metrics refreshed."); }
    catch { setStatus("Couldn't refresh metrics."); }
    finally { setRefreshingMetrics(false); }
  }

  // A failed refresh keeps the last good price, flagged "stale", rather than blanking the row.
  const { quotes, stale } = useMemo(() => {
    const merged: Record<string, QuoteLike> = {}; const staleSet = new Set<string>();
    for (const [sym, q] of Object.entries(quotesQ.data ?? {})) {
      if (q.error === null && q.price !== null) { lastGood.current[sym] = q; merged[sym] = q; }
      else if (lastGood.current[sym]) { merged[sym] = lastGood.current[sym]; staleSet.add(sym); }
      else merged[sym] = q;
    }
    return { quotes: merged, stale: staleSet };
  }, [quotesQ.data]);

  const benchParam = search.get("bench");
  const selectedId = entryParam ? Number(entryParam) : null;
  const selected = entries.find((e) => e.entryId === selectedId) ?? null;
  const detailQ = useQuery({ queryKey: ["entry", watchlistId, selectedId], enabled: selectedId !== null, queryFn: () => getJson(`/api/watchlists/${watchlistId}/entries/${selectedId}`) });
  const seriesQ = useQuery({ queryKey: ["series", watchlistId, selectedId], enabled: selectedId !== null, retry: false, queryFn: () => getJson(`/api/watchlists/${watchlistId}/entries/${selectedId}/series`) });

  function select(id: number) {
    const p = new URLSearchParams(search.toString());
    p.set("entry", String(id)); p.delete("bench");
    router.replace(`?${p.toString()}`, { scroll: false });
  }
  function selectBenchmark(symbol: string) {
    const p = new URLSearchParams(search.toString());
    p.set("bench", symbol); p.delete("entry");
    router.replace(`?${p.toString()}`, { scroll: false });
  }
  const dataViewRows = useMemo(() => (views ? views.sections.flatMap((sec) => sec.rows) : []), [views]);
  const selectedBench = benchParam ? dataViewRows.find((r) => r.kind === "index" && r.symbol === benchParam) ?? null : null;
  useEffect(() => { if (view && selectedId === null && !benchParam && entries.length > 0 && window.matchMedia?.("(min-width: 1000px)").matches) select(entries[0].entryId); /* eslint-disable-next-line */ }, [view]);

  async function refresh() {
    if (cooling) return;
    setCooling(true); setTimeout(() => setCooling(false), 1000);
    setStatus("Refreshing prices…");
    const r = await quotesQ.refetch();
    setStatus(r.isError ? "Couldn't refresh prices." : "Prices refreshed.");
  }

  async function editAsNewVersion() {
    const res = await fetch(`/api/prompts/${view.promptId}/edit`, { method: "POST" });
    if (res.ok) router.push(`/drafts/${(await res.json()).draft_id}`);
  }

  async function dryRun() {
    setDry({ open: true, busy: true });
    try {
      const asOf = view.lastRun?.asOf ?? healthQ.data?.last_bar_date;
      setDry({ open: true, busy: false, result: await postJson(`/api/drafts/${view.draftId}/program/screen`, { as_of: asOf }) });
    } catch (e) { setDry({ open: true, busy: false, error: (e as Error).message }); }
  }

  const usdPerInr = views?.fx?.usdPerInr ?? null;
  function download(name: string, csv: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = name; a.click();
  }
  function exportCurrent() {
    if (viewId === "screen" || !views) return exportCsv();
    const cols = visibleColumns(viewId as DataView, hiddenCols);
    download(`prompt-${view.promptId}-watchlist-${viewId}.csv`, buildViewCsv({ view: VIEW_LABELS[viewId], sections: views.sections, cols, ctx: { ccy, usdPerInr }, query, asOf: views.asOf }));
  }

  function exportCsv() {
    const asOf = newestAsOf(quotes);
    const rows = [[`# Prices as of ${asOf ?? "not fetched"} (Yahoo Finance, may be delayed)`], ["Symbol", "Name", "Status", "LTP", "Today %", "Since entry %", "Entry", "Stop"],
      ...visible.map((e: any) => { const s = sinceEntry(e, quotes[e.symbol]); const q = quotes[e.symbol]; return [e.symbol, e.name ?? "", e.status, q?.price ?? "", q?.chgPct?.toFixed(2) ?? "", s ? s.pct.toFixed(2) : "", e.entryPrice ?? "", e.stop ?? ""]; })];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `prompt-${view.promptId}-watchlist.csv`; a.click();
  }

  if (viewQ.isError) return <main><p role="alert">{(viewQ.error as Error).message}</p></main>;
  if (!view) return <main><p>Loading…</p></main>;

  const hasNearMiss = entries.some((e) => e.membership === "near_miss");
  const tabs = [
    { id: "all" as Tab, label: "All", count: entries.length },
    { id: "full_match" as Tab, label: "Arm picks", count: entries.filter((e) => e.membership === "full_match").length },
    ...(hasNearMiss ? [{ id: "near_miss" as Tab, label: "Near miss", count: entries.filter((e) => e.membership === "near_miss").length }] : []),
    ...(view.hasRiskCap ? [{ id: "rejected_risk_cap" as Tab, label: "Rejected (risk cap)", count: entries.filter((e) => e.membership === "rejected_risk_cap").length }] : []),
  ];
  const needle = query.trim().toLowerCase();
  const visible = entries.filter((e) => (tab === "all" || e.membership === tab) && (!needle || e.symbol.toLowerCase().includes(needle) || (e.name ?? "").toLowerCase().includes(needle)));
  const conds = view.conditions as { condNo: number; label: string; valueOrigin: string }[];
  const asOf = newestAsOf(quotes);

  return (
    <main>
      {notice && <Banner tone="warn">{notice}</Banner>}
      <Header view={view} onEdit={() => void editAsNewVersion()} onDryRun={() => void dryRun()} onExport={exportCsv} busy={dry.busy} />
      <PromptCard promptText={view.promptText} conditions={conds} whatRuns={view.whatRuns ?? []} />
      <PricesBar asOf={asOf} lastBarDate={healthQ.data?.last_bar_date ?? null} onRefresh={() => void refresh()} fetching={quotesQ.isFetching || cooling} status={status} error={quotesQ.isError ? (quotesQ.error as Error).message : null}
        extraLine={views ? `Fundamentals as of ${views.asOf.fundamentals ? fmtDate(views.asOf.fundamentals) : "not fetched"} · Metrics as of last close ${views.asOf.metrics ? fmtDate(views.asOf.metrics) : "not computed"}${ccy === "USD" ? ` · FX as of ${views.asOf.fx ? views.asOf.fx.slice(0, 16).replace("T", " ") : "unavailable"}` : ""}` : null} />
      <KpiRow entries={entries} quotes={quotes} hasNearMiss={hasNearMiss} lastRunAsOf={view.lastRun?.asOf ?? null} entryAt={view.entryAt} />

      <div className={styles.layout}>
        <div className={styles.main}>
          <ViewToolbar
            view={viewId} onView={changeView} ccy={ccy} onCcy={changeCcy} fxAsOf={views?.fx?.asOf ?? null} fxAvailable={usdPerInr !== null}
            tf={tf} onTf={changeTf} columns={viewId === "screen" ? null : COLUMNS[viewId as DataView]} hidden={hiddenCols[viewId] ?? []} onHidden={(h) => changeHidden(viewId as DataView, h)}
            onDownload={exportCurrent} onRefreshMetrics={() => void refreshMetrics()} refreshing={refreshingMetrics} compact={compact} onCompact={changeCompact}
          />
          <div className={styles.toolbar}>
            {viewId === "screen" ? <Segmented label="Membership" items={tabs} value={tab} onChange={setTab} /> : <span />}
            <input type="search" className={styles.search} aria-label="Search stocks" placeholder="Search symbol or name" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {!view.hasRiskCap && viewId === "screen" && <p className={styles.sub}>No risk-cap tab: this prompt doesn't set a risk cap.</p>}
          {viewId === "screen" ? (
            <WatchlistGrid entries={visible} conditions={conds} quotes={quotes} stale={stale} closes={closesQ.data ?? {}} selectedId={selectedId} onSelect={select} ccy={ccy} usdPerInr={usdPerInr} />
          ) : views ? (
            <ViewGrid
              view={viewId as DataView} sections={views.sections} hidden={hiddenCols} ctx={{ ccy, usdPerInr }} query={query} compact={compact}
              selectedKey={selectedBench ? `bench:${selectedBench.symbol}` : selectedId !== null ? `entry:${selectedId}` : null}
              onSelect={(r: ViewRow) => (r.entryId !== undefined ? select(r.entryId) : selectBenchmark(r.symbol))}
            />
          ) : viewsQ.isError ? <p role="alert">Couldn't load this view.</p> : <p>Loading view…</p>}
        </div>
        <aside className={styles.aside} aria-label="Selected stock">
          {selectedBench && viewId !== "screen" ? <BenchmarkPanel row={selectedBench} /> : selected ? (
            <DetailPanel
              entry={selected as DetailEntry} conditions={conds} quote={quotes[selected.symbol]} bars={seriesQ.isError ? [] : (seriesQ.data?.bars ?? null)}
              extra={detailQ.data ?? null} entryAt={view.entryAt} canRemove
              onSaveNote={async (note) => { const r = await fetch(`/api/watchlists/${watchlistId}/entries/${selected.entryId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ userNote: note }) }); if (r.ok) void qc.invalidateQueries({ queryKey: ["entry", watchlistId, selected.entryId] }); return r.ok; }}
              onRemove={async () => { await fetch(`/api/watchlists/${watchlistId}/entries/${selected.entryId}`, { method: "DELETE" }); router.replace("?", { scroll: false }); await qc.invalidateQueries({ queryKey: ["watchlist", watchlistId] }); }}
            />
          ) : <p className={styles.sub}>Select a stock to see its detail.</p>}
        </aside>
      </div>

      <ValidationTiles gradedWeeks={view.validation.gradedWeeks} horizons={view.validation.horizons} gradedAsOf={view.validation.gradedAsOf} dueDates={view.validation.dueDates} controls={view.validation.controls} />

      <Dialog open={dry.open} onClose={() => setDry({ open: false, busy: false })} title="Dry run" actions={<Button onClick={() => setDry({ open: false, busy: false })}>Close</Button>}>
        {dry.busy ? <p>Running…</p> : dry.error ? <p role="alert">{dry.error}</p> : dry.result ? (
          <div className={styles.dialogBody} aria-label="dry run result">
            <p>{dry.result.universe?.count ?? "?"} stocks in the universe · week of {dry.result.as_of}</p>
            <ul>{Object.entries(dry.result.sets ?? {}).map(([id, s]: [string, any]) => <li key={id}>{id}: {s.count} stock{s.count === 1 ? "" : "s"}</li>)}</ul>
          </div>
        ) : null}
        <p className={styles.sub}>Not recorded in the forward test.</p>
      </Dialog>
    </main>
  );
}

export default function WatchlistPage({ params }: { params: { watchlistId: string } }) {
  return <Suspense fallback={<main><p>Loading…</p></main>}><WatchlistScreen watchlistId={params.watchlistId} /></Suspense>;
}

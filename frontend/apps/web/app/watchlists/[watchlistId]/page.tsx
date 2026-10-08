"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { describeApiError } from "@/lib/apiError";
import { newestAsOf, fmtPrice, fmtSignedPct, sinceEntry, type QuoteLike } from "@/lib/watchlistMath";
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

  const selectedId = entryParam ? Number(entryParam) : null;
  const selected = entries.find((e) => e.entryId === selectedId) ?? null;
  const detailQ = useQuery({ queryKey: ["entry", watchlistId, selectedId], enabled: selectedId !== null, queryFn: () => getJson(`/api/watchlists/${watchlistId}/entries/${selectedId}`) });
  const seriesQ = useQuery({ queryKey: ["series", watchlistId, selectedId], enabled: selectedId !== null, retry: false, queryFn: () => getJson(`/api/watchlists/${watchlistId}/entries/${selectedId}/series`) });

  function select(id: number) {
    const p = new URLSearchParams(search.toString());
    p.set("entry", String(id));
    router.replace(`?${p.toString()}`, { scroll: false });
  }
  useEffect(() => { if (view && selectedId === null && entries.length > 0 && window.matchMedia?.("(min-width: 1000px)").matches) select(entries[0].entryId); /* eslint-disable-next-line */ }, [view]);

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
      <PricesBar asOf={asOf} lastBarDate={healthQ.data?.last_bar_date ?? null} onRefresh={() => void refresh()} fetching={quotesQ.isFetching || cooling} status={status} error={quotesQ.isError ? (quotesQ.error as Error).message : null} />
      <KpiRow entries={entries} quotes={quotes} hasNearMiss={hasNearMiss} lastRunAsOf={view.lastRun?.asOf ?? null} entryAt={view.entryAt} />

      <div className={styles.layout}>
        <div className={styles.main}>
          <div className={styles.toolbar}>
            <Segmented label="Membership" items={tabs} value={tab} onChange={setTab} />
            <input type="search" className={styles.search} aria-label="Search stocks" placeholder="Search symbol or name" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {!view.hasRiskCap && <p className={styles.sub}>No risk-cap tab: this prompt doesn't set a risk cap.</p>}
          <WatchlistGrid entries={visible} conditions={conds} quotes={quotes} stale={stale} closes={closesQ.data ?? {}} selectedId={selectedId} onSelect={select} />
        </div>
        <aside className={styles.aside} aria-label="Selected stock">
          {selected ? (
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

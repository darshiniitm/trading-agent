"use client";
import { useEffect, useState } from "react";
import { WatchlistTable } from "@/components/WatchlistTable";
import { describeApiError } from "@/lib/apiError";

type Tab = "all" | "full_match" | "near_miss" | "rejected_risk_cap";
type Quote = { price: number | null; asOf: string | null; error: string | null };

export default function WatchlistPage({ params }: { params: { watchlistId: string } }) {
  const [view, setView] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [quotesError, setQuotesError] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`/api/watchlists/${params.watchlistId}`);
    const body = await res.json();
    if (!res.ok) {
      setLoadError(describeApiError(body, "couldn't load this watchlist"));
      return;
    }
    setView(body);
    return body;
  }

  async function refreshPrices(current: any) {
    const symbols = current.entries.map((e: any) => e.symbol);
    if (symbols.length === 0) return;
    const res = await fetch("/api/quotes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbols }),
    });
    const body = await res.json();
    if (!res.ok) {
      setQuotesError(describeApiError(body, "couldn't fetch prices"));
      return;
    }
    setQuotesError(null);
    setQuotes(body);
  }

  useEffect(() => {
    load().then((loaded) => {
      if (loaded) refreshPrices(loaded);
    });
  }, [params.watchlistId]);

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!view) return <p>Loading…</p>;

  const visibleEntries = tab === "all" ? view.entries : view.entries.filter((e: any) => e.membership === tab);

  const asOfValues = Object.values(quotes)
    .map((q) => q.asOf)
    .filter((a): a is string => !!a)
    .sort();
  const pricesAsOf = asOfValues.length > 0 ? asOfValues[asOfValues.length - 1] : null;

  return (
    <main>
      <h1>{view.title}</h1>
      <p>{view.structure} · Shadow arm · graded vs Control</p>
      <p>{view.hypothesis}</p>

      <section>
        <h2>Your conditions</h2>
        <ul>
          {view.conditions.map((c: any) => (
            <li key={c.condNo}>
              C{c.condNo}: {c.kind} {c.name} {c.op} {JSON.stringify(c.value)} — <em>{c.valueOrigin === "prompt" ? "from the prompt" : "your answer"}</em>
            </li>
          ))}
        </ul>
      </section>

      <p>
        Prices as of {pricesAsOf ?? "not yet fetched"} · Yahoo Finance · may be delayed{" "}
        <button type="button" onClick={() => refreshPrices(view)}>Refresh prices</button>
      </p>
      {quotesError && <p role="alert">{quotesError}</p>}

      <nav>
        <button type="button" onClick={() => setTab("all")} aria-pressed={tab === "all"}>All</button>
        <button type="button" onClick={() => setTab("full_match")} aria-pressed={tab === "full_match"}>Arm picks</button>
        <button type="button" onClick={() => setTab("near_miss")} aria-pressed={tab === "near_miss"}>Near miss</button>
        {view.hasRiskCap && (
          <button type="button" onClick={() => setTab("rejected_risk_cap")} aria-pressed={tab === "rejected_risk_cap"}>
            Rejected (risk cap)
          </button>
        )}
      </nav>
      {!view.hasRiskCap && <p>No risk-cap tab: this prompt doesn't set a risk cap.</p>}

      <WatchlistTable entries={visibleEntries} conditionNames={view.conditions.map((c: any) => `C${c.condNo}`)} quotes={quotes} />
    </main>
  );
}

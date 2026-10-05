"use client";
import { useEffect, useState } from "react";
import { WatchlistTable } from "@/components/WatchlistTable";

type Tab = "all" | "full_match" | "near_miss";

export default function WatchlistPage({ params }: { params: { watchlistId: string } }) {
  const [view, setView] = useState<any>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [pricesAsOf, setPricesAsOf] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`/api/watchlists/${params.watchlistId}`);
    setView(await res.json());
  }

  async function refreshPrices(current: any) {
    const symbols = current.entries.map((e: any) => e.symbol);
    if (symbols.length === 0) return;
    await fetch("/api/quotes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbols }),
    });
    setPricesAsOf(new Date().toISOString());
  }

  useEffect(() => {
    load();
  }, [params.watchlistId]);

  if (!view) return <p>Loading…</p>;

  const visibleEntries =
    tab === "all" ? view.entries : view.entries.filter((e: any) => e.membership === tab);

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

      <nav>
        <button type="button" onClick={() => setTab("all")} aria-pressed={tab === "all"}>All</button>
        <button type="button" onClick={() => setTab("full_match")} aria-pressed={tab === "full_match"}>Arm picks</button>
        <button type="button" onClick={() => setTab("near_miss")} aria-pressed={tab === "near_miss"}>Near miss</button>
      </nav>

      <WatchlistTable entries={visibleEntries} conditionNames={view.conditions.map((c: any) => `C${c.condNo}`)} />
    </main>
  );
}

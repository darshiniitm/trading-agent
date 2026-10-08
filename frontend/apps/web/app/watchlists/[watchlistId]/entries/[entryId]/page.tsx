"use client";
import { useEffect, useState } from "react";
import { EntryTimeline } from "@/components/EntryTimeline";
import { describeApiError } from "@/lib/apiError";
import { Card } from "@/ui/Card";
import { PriceChart } from "@/ui/PriceChart";

type EntryDetail = {
  entryId: number; symbol: string; membership: string; status: string;
  entryPrice: number | null; stop: number | null; refPrice: number | null; userNote: string | null;
  events: { type: string; fromValue: string | null; toValue: string | null; at: string }[];
};
type Bar = { close: number | null; vstop_line?: number | null };

// Deep-link view of one stock: the same detail the watchlist's side panel shows, full width.
export default function EntryDetailPage({ params }: { params: { watchlistId: string; entryId: string } }) {
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bars, setBars] = useState<Bar[]>([]);

  useEffect(() => {
    fetch(`/api/watchlists/${params.watchlistId}/entries/${params.entryId}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(describeApiError(body, "couldn't load this entry"));
        setDetail(body);
      })
      .catch((err: Error) => setLoadError(err.message));
    // The chart is a nicety: if the engine is down the rest of the page still works.
    fetch(`/api/watchlists/${params.watchlistId}/entries/${params.entryId}/series`)
      .then(async (res) => { const b = await res.json(); if (res.ok && Array.isArray(b?.bars)) setBars(b.bars); })
      .catch(() => undefined);
  }, [params.watchlistId, params.entryId]);

  const back = <p><a href={`/watchlists/${params.watchlistId}`}>Back to watchlist</a></p>;
  if (loadError) return <main>{back}<p role="alert">{loadError}</p></main>;
  if (!detail) return <main>{back}<p>Loading…</p></main>;

  const closes = bars.map((b) => b.close).filter((c): c is number => typeof c === "number").slice(-52);
  const vstop = bars.slice(-closes.length).map((b) => b.vstop_line ?? null);

  return (
    <main>
      {back}
      <h1>{detail.symbol}</h1>
      <Card title="Status and levels">
        <dl>
          <dt>Status</dt><dd>{detail.status}</dd>
          <dt>Membership</dt><dd>{detail.membership}</dd>
          <dt>Entry price</dt><dd>{detail.entryPrice ?? "—"}</dd>
          <dt>Stop</dt><dd>{detail.stop ?? "—"}</dd>
          {detail.refPrice !== null && (<><dt>Reference price</dt><dd>{detail.refPrice}</dd></>)}
        </dl>
      </Card>
      {closes.length >= 2 && <Card title="Weekly closes"><PriceChart closes={closes} overlays={vstop.some((v) => v !== null) ? [{ name: "VStop", values: vstop, color: "var(--blue)" }] : []} /></Card>}
      <Card title="History"><EntryTimeline events={detail.events} /></Card>
    </main>
  );
}

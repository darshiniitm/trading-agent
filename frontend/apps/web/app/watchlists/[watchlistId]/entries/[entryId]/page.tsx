"use client";
import { useEffect, useState } from "react";
import { EntryTimeline } from "@/components/EntryTimeline";
import { describeApiError } from "@/lib/apiError";

type EntryDetail = {
  entryId: number; symbol: string; membership: string; status: string;
  entryPrice: number | null; stop: number | null; refPrice: number | null; userNote: string | null;
  events: { type: string; fromValue: string | null; toValue: string | null; at: string }[];
};

export default function EntryDetailPage({ params }: { params: { watchlistId: string; entryId: string } }) {
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/watchlists/${params.watchlistId}/entries/${params.entryId}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(describeApiError(body, "couldn't load this entry"));
        setDetail(body);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, [params.watchlistId, params.entryId]);

  const back = <a href={`/watchlists/${params.watchlistId}`}>Back to watchlist</a>;
  if (loadError) return <main>{back}<p role="alert">{loadError}</p></main>;
  if (!detail) return <main>{back}<p>Loading…</p></main>;

  return (
    <main>
      {back}
      <h1>{detail.symbol}</h1>
      <dl>
        <dt>Status</dt><dd>{detail.status}</dd>
        <dt>Membership</dt><dd>{detail.membership}</dd>
        <dt>Entry price</dt><dd>{detail.entryPrice ?? "—"}</dd>
        <dt>Stop</dt><dd>{detail.stop ?? "—"}</dd>
        {detail.refPrice !== null && (<><dt>Reference price</dt><dd>{detail.refPrice}</dd></>)}
      </dl>
      <h2>History</h2>
      <EntryTimeline events={detail.events} />
    </main>
  );
}

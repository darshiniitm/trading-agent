"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import registry from "spec/src/registry.json";
import { FieldSelect } from "@/ui/Fields";
import { Banner } from "@/ui/Banner";
import { PromptCard, type ExploreRow } from "@/components/explore/PromptCard";
import styles from "@/components/explore/explore.module.css";

const CONDITIONS: { name: string; label: string }[] = [...((registry as any).fields ?? []), ...((registry as any).indicators ?? [])].map((x: any) => ({ name: x.name, label: x.label ?? x.name }));

export default function ExplorePage() {
  const qc = useQueryClient();
  const [condition, setCondition] = useState("");
  const [sort, setSort] = useState("");
  const [error, setError] = useState<string | null>(null);

  const key = ["explore", condition, sort];
  const rowsQ = useQuery<ExploreRow[]>({
    queryKey: key,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (condition) params.set("uses_condition", condition);
      if (sort) params.set("sort", sort);
      const res = await fetch(`/api/explore?${params}`);
      return res.ok ? res.json() : [];
    },
  });
  const rows = Array.isArray(rowsQ.data) ? rowsQ.data : [];

  // Optimistic: flip the button and follower count at once, roll back if the server refuses.
  async function toggleFollow(row: ExploreRow) {
    setError(null);
    const previous = qc.getQueryData<ExploreRow[]>(key);
    qc.setQueryData<ExploreRow[]>(key, (old) => (old ?? []).map((r) => r.promptId === row.promptId ? { ...r, isFollowing: !r.isFollowing, followers: r.followers + (r.isFollowing ? -1 : 1) } : r));
    try {
      const res = await fetch(`/api/prompts/${row.promptId}/follow`, { method: row.isFollowing ? "DELETE" : "POST" });
      if (!res.ok) throw new Error("failed");
    } catch {
      qc.setQueryData(key, previous);
      setError(`Couldn't ${row.isFollowing ? "unfollow" : "follow"} Prompt ${row.promptId}. Nothing changed.`);
    }
  }
  async function copyPrompt(promptId: number) {
    const res = await fetch(`/api/prompts/${promptId}/copy`, { method: "POST" });
    if (res.ok) window.location.href = `/drafts/${(await res.json()).draft_id}`;
    else setError(`Couldn't copy Prompt ${promptId}.`);
  }

  return (
    <main>
      <h1>Explore</h1>
      <p className={styles.intro}>Shared prompts from other people. <strong>Follow</strong> one to get its watchlist and see how it grades against Control, or <strong>Copy to my drafts</strong> to start from its wording.</p>
      <div className={styles.filters}>
        <FieldSelect label="Uses condition" aria-label="filter by condition" value={condition} onChange={(e) => setCondition(e.target.value)}>
          <option value="">Any</option>
          {CONDITIONS.map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
        </FieldSelect>
        <FieldSelect label="Sort" aria-label="sort" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="graded_weeks">Most graded weeks</option>
          <option value="">Newest Prompt ID</option>
          <option value="followers">Most followers</option>
        </FieldSelect>
        <span className={styles.spacer} />
        <span className={styles.note}>graded weeks are shadow (paper) results</span>
      </div>
      {error && <Banner tone="warn" role="alert">{error}</Banner>}
      {rowsQ.isSuccess && rows.length === 0 && <p className={styles.note}>No shared prompts match.</p>}
      <div className={styles.grid}>
        {rows.map((row) => <PromptCard key={row.promptId} row={row} onFollow={(r) => void toggleFollow(r)} onCopy={(id) => void copyPrompt(id)} />)}
      </div>
    </main>
  );
}

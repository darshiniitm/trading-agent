"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { VersionChain } from "@/components/VersionChain";
import { PromptGrid, type PromptRow } from "@/components/prompts/PromptGrid";
import { DraftCards, type DraftRow } from "@/components/prompts/DraftCards";
import { Segmented } from "@/ui/Segmented";
import { LinkButton, Button } from "@/ui/Button";
import { Card } from "@/ui/Card";
import { Banner } from "@/ui/Banner";
import { Dialog } from "@/ui/Dialog";
import styles from "@/components/prompts/prompts.module.css";

type Tab = "mine" | "drafts" | "following";
const list = (view: string) => () => fetch(`/api/prompts?view=${view}`).then((r) => r.json());

export default function PromptsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("mine");
  const [selected, setSelected] = useState<number | null>(null);
  const [retiring, setRetiring] = useState<number | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const mineQ = useQuery<PromptRow[]>({ queryKey: ["prompts", "mine"], queryFn: list("mine") });
  const draftsQ = useQuery<DraftRow[]>({ queryKey: ["prompts", "drafts"], queryFn: list("drafts") });
  const followingQ = useQuery<PromptRow[]>({ queryKey: ["prompts", "following"], queryFn: list("following") });
  const mine = Array.isArray(mineQ.data) ? mineQ.data : [];
  const drafts = Array.isArray(draftsQ.data) ? draftsQ.data : [];
  const following = Array.isArray(followingQ.data) ? followingQ.data : [];
  const chainFor = mine.find((p) => p.promptId === selected) ?? mine.find((p) => p.parentPromptId) ?? null;

  async function editAsNewVersion(promptId: number) {
    const res = await fetch(`/api/prompts/${promptId}/edit`, { method: "POST" });
    if (res.ok) window.location.href = `/drafts/${(await res.json()).draft_id}`;
  }
  async function retire(promptId: number) {
    setRetiring(null);
    const res = await fetch(`/api/prompts/${promptId}/retire`, { method: "POST" });
    if (!res.ok) return;
    const body = await res.json();
    if (body.warning) setWarning(String(body.warning));
    void qc.invalidateQueries({ queryKey: ["prompts"] });
  }
  async function toggleShare(promptId: number, shared: boolean) {
    const res = await fetch(`/api/prompts/${promptId}/visibility`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: shared ? "private" : "shared" }) });
    if (res.ok) void qc.invalidateQueries({ queryKey: ["prompts", "mine"] });
  }

  return (
    <main>
      <div className={styles.top}>
        <h1>My prompts</h1>
        <LinkButton href="/drafts/new" variant="primary" size={44}>New prompt</LinkButton>
      </div>
      {warning && <Banner tone="warn" role="status">{warning}</Banner>}
      <div style={{ marginBottom: 16 }}>
        <Segmented label="Prompt lists" value={tab} onChange={setTab}
          items={[{ id: "mine", label: "Mine", count: mine.length }, { id: "following", label: "Following", count: following.length }, { id: "drafts", label: "Drafts", count: drafts.length }]} />
      </div>

      {tab === "mine" && (
        <>
          <PromptGrid rows={mine} mode="mine" selectedId={chainFor?.promptId ?? null} onSelect={setSelected} onEdit={(id) => void editAsNewVersion(id)} onRetire={setRetiring} onShare={(id, shared) => void toggleShare(id, shared)} />
          {chainFor && <div style={{ marginTop: 16 }}><Card title="Version history"><VersionChain promptId={chainFor.promptId} parentPromptId={chainFor.parentPromptId ?? null} version={chainFor.version ?? 1} /></Card></div>}
        </>
      )}
      {tab === "following" && <PromptGrid rows={following} mode="following" />}
      {tab === "drafts" && <DraftCards drafts={drafts} />}

      <Dialog open={retiring !== null} onClose={() => setRetiring(null)} title={`Retire Prompt ${retiring}?`}
        actions={<><Button onClick={() => setRetiring(null)}>Cancel</Button><Button variant="primary" onClick={() => retiring !== null && void retire(retiring)}>Retire</Button></>}>
        <p>Retiring stops the prompt being graded. Its records are kept and nothing is rewritten.</p>
      </Dialog>
    </main>
  );
}

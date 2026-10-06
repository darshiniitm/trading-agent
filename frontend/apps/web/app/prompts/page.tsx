"use client";
import { useEffect, useState } from "react";
import { VersionChain } from "@/components/VersionChain";

type Tab = "mine" | "drafts" | "following";

export default function PromptsPage() {
  const [tab, setTab] = useState<Tab>("mine");
  const [mine, setMine] = useState<any[] | null>(null);
  const [drafts, setDrafts] = useState<any[] | null>(null);

  useEffect(() => {
    fetch("/api/prompts?view=mine").then((r) => r.json()).then(setMine);
    fetch("/api/prompts?view=drafts").then((r) => r.json()).then(setDrafts);
  }, []);

  async function editAsNewVersion(promptId: number) {
    const res = await fetch(`/api/prompts/${promptId}/edit`, { method: "POST" });
    if (res.ok) {
      const { draft_id } = await res.json();
      window.location.href = `/drafts/${draft_id}`;
    }
  }

  async function retire(promptId: number) {
    const res = await fetch(`/api/prompts/${promptId}/retire`, { method: "POST" });
    if (!res.ok) return;
    const body = await res.json();
    if (body.warning) window.alert(body.warning);
    setMine((rows) => rows!.map((r) => (r.promptId === promptId ? { ...r, status: "retired" } : r)));
  }

  return (
    <main>
      <h1>My prompts</h1>
      <nav>
        <button type="button" onClick={() => setTab("mine")} aria-pressed={tab === "mine"}>Mine</button>
        <button type="button" onClick={() => setTab("following")} aria-pressed={tab === "following"} disabled>
          Following (needs sharing, not yet built)
        </button>
        <button type="button" onClick={() => setTab("drafts")} aria-pressed={tab === "drafts"}>Drafts</button>
      </nav>

      {tab === "mine" && (
        <table>
          <thead>
            <tr>
              <th>Prompt</th><th>Title</th><th>Structure</th><th>Status</th><th>Graded</th><th>1-week return</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(mine ?? []).map((p) => (
              <tr key={p.promptId}>
                <td><VersionChain promptId={p.promptId} parentPromptId={p.parentPromptId} version={p.version} /></td>
                <td>{p.title}</td>
                <td>{p.structure}</td>
                <td>{p.status}</td>
                <td>week {p.gradedWeeks} of 13</td>
                <td>{p.lastHorizon1Return === null ? "not graded yet" : `${p.lastHorizon1Return.toFixed(2)}%`}</td>
                <td>
                  {p.watchlistId !== null && <><a href={`/watchlists/${p.watchlistId}`}>Open watchlist</a>{" "}</>}
                  {p.status === "confirmed" && (
                    <>
                      <button type="button" onClick={() => editAsNewVersion(p.promptId)}>Edit as new version</button>{" "}
                      <button type="button" onClick={() => retire(p.promptId)}>Retire</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "drafts" && (
        <ul>
          {(drafts ?? []).map((d) => (
            <li key={d.draftId}>
              Draft {d.draftId} — {d.blockedReason ?? "Ready to confirm"} — <a href={`/drafts/${d.draftId}`}>Continue</a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

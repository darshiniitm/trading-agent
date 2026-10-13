"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { POLL_BUSY_MS, POLL_READY_MS, type EngineStatus } from "@/lib/engineStatus";

// Polls the engine's state. Every poll is also this tab's heartbeat: the server stops an engine nobody is looking at and
// brings it back on the next beat. Fast while the engine is loading, slow once ready; paused while the tab is hidden.

async function fetchStatus(): Promise<EngineStatus> {
  const res = await fetch("/api/engine/status", { cache: "no-store" });
  if (!res.ok) throw new Error(`engine status ${res.status}`);
  return res.json();
}

export function useEngineStatus() {
  const qc = useQueryClient();
  const q = useQuery<EngineStatus>({
    queryKey: ["engine-status"],
    queryFn: fetchStatus,
    refetchInterval: (query) => (query.state.data?.state === "ready" ? POLL_READY_MS : POLL_BUSY_MS),
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
  });
  const retry = useMutation({
    mutationFn: async () => (await fetch("/api/engine/retry", { method: "POST" })).json() as Promise<EngineStatus>,
    onSuccess: (s) => qc.setQueryData(["engine-status"], s),
  });
  return { status: q.data ?? null, unreachable: q.isError, refetch: q.refetch, retry: () => retry.mutate(), retrying: retry.isPending };
}

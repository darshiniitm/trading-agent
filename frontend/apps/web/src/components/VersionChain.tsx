export function VersionChain({ promptId, parentPromptId, version }: { promptId: number; parentPromptId: number | null; version: number }) {
  if (parentPromptId === null) {
    return <span>Prompt {promptId} (version {version})</span>;
  }
  return (
    <span>
      Prompt {parentPromptId} → Prompt {promptId} (version {version}) — <em>old versions keep their records and stop being graded</em>
    </span>
  );
}

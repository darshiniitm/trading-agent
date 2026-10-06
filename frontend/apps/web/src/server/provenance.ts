// Provenance invalidation for the generic, manual-edit save path
// (PATCH /api/drafts/:draftId — DraftEditor's saveSpec()).
//
// confirm.ts marks a condition 'prompt'-origin (with its source phrase) when
// every traceable leaf of it has a draft.sourcePhrases entry. That claim is
// only true while the value at each traced path is still the value the
// compiler traced. A manual edit through the always-editable condition rows
// can change it, so a manual save that changes ANY traced value — or the
// identity of a condition a traced path points into, or removes/reorders
// conditions so a traced path now lands on a different one — invalidates ALL
// provenance for the draft (coarse on purpose: no attempt to work out which
// single condition changed). Every condition then falls back to
// 'user_answer' at confirm time, which can never over-claim.
//
// A save that leaves every traced value exactly as compiled (e.g. the save
// that confirm() always does first, which only appends the app-asked
// liquidity filter and the hypothesis/kill criterion) keeps provenance —
// otherwise no compiled condition could ever be confirmed as 'prompt'-origin
// through the UI, since the UI always saves before it confirms.

type AnySpec = { conditions?: unknown[] } & Record<string, unknown>;

const CONDITION_IDENTITY_FIELDS = ["id", "role", "kind", "name", "op", "dir"] as const;

function getAtPath(obj: unknown, path: string): unknown {
  let node: any = obj;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object" || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function manualEditInvalidatesProvenance(
  storedSpec: AnySpec | null,
  sourcePhrases: { path: string }[] | null,
  incomingSpecJson: string
): boolean {
  if (!sourcePhrases || sourcePhrases.length === 0) return false; // nothing claimed, nothing to invalidate
  if (!storedSpec) return true;
  let incoming: AnySpec;
  try {
    incoming = JSON.parse(incomingSpecJson);
  } catch {
    return true; // updateDraft will reject it anyway; never keep provenance on doubt
  }

  for (const { path } of sourcePhrases) {
    if (!same(getAtPath(storedSpec, path), getAtPath(incoming, path))) return true;
    const m = /^conditions\.(\d+)\./.exec(path);
    if (m) {
      const before = (storedSpec.conditions ?? [])[Number(m[1])] as Record<string, unknown> | undefined;
      const after = (incoming.conditions ?? [])[Number(m[1])] as Record<string, unknown> | undefined;
      if (!before || !after) return true;
      if (CONDITION_IDENTITY_FIELDS.some((f) => !same(before[f], after[f]))) return true;
    }
  }
  return false;
}

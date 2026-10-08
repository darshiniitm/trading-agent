// Liquidity is the one question the app itself asks (D3), never the model and never defaulted: a floor on
// median weekly traded value, or an explicit "no filter". The floor becomes a normal condition on the set
// that starts from the universe; the user's own number is traced through their answer.
import type { ScreenProgram } from "spec";
import { AnswerError } from "./answer";

export type LiquidityChoice = { mode: "none" } | { mode: "floor"; cr: number };
export const LIQUIDITY_PHRASE = "liquidity floor (your answer)";
const WINDOW = "8W";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function dropLeaf(node: any, id: string): any {
  if (typeof node === "string") return node === id ? null : node;
  for (const k of ["all", "any"]) if (node[k]) { node[k] = node[k].map((c: any) => dropLeaf(c, id)).filter((c: any) => c !== null); }
  return node;
}

export function liquidityState(p: ScreenProgram): { answered: boolean; mode: "none" | "floor" | null; cr: number | null } {
  const answered = p.answers.some((a) => a.path === "liquidity");
  const c = p.conditions.find((x) => x.phrase === LIQUIDITY_PHRASE);
  return { answered, mode: answered ? (c ? "floor" : "none") : null, cr: c && typeof c.value === "number" ? c.value : null };
}

export function applyLiquidity(program: ScreenProgram, choice: LiquidityChoice): ScreenProgram {
  const p = clone(program);
  // re-answering replaces the previous answer cleanly
  const prev = p.conditions.find((c) => c.phrase === LIQUIDITY_PHRASE);
  if (prev) {
    p.conditions = p.conditions.filter((c) => c.id !== prev.id);
    p.sets.forEach((s) => { s.where = dropLeaf(s.where, prev.id); });
    p.answers = p.answers.filter((a) => !a.path.startsWith(`conditions.${prev.id}.`));
  }
  p.answers = p.answers.filter((a) => a.path !== "liquidity");

  if (choice.mode === "floor") {
    if (!(typeof choice.cr === "number" && Number.isFinite(choice.cr) && choice.cr > 0)) throw new AnswerError("the liquidity floor must be a positive number of crore per week");
    const base = p.sets.find((s) => s.from === "universe");
    if (!base) throw new AnswerError("there is nothing to screen yet — interpret a prompt first");
    const next = p.conditions.reduce((m, c) => Math.max(m, Number(/^C(\d+)$/.exec(c.id)?.[1] ?? 0)), 0) + 1;
    const id = `C${next}`;
    p.conditions.push({ id, lhs: { field: "traded_value_cr", params: { window: WINDOW } }, op: ">=", value: choice.cr, phrase: LIQUIDITY_PHRASE });
    base.where = (base.where as any).all ? { all: [...(base.where as any).all, id] } : { all: [base.where, id] };
    p.answers.push({ path: `conditions.${id}.value` }, { path: `conditions.${id}.params.window` });
  } else if (choice.mode !== "none") {
    throw new AnswerError("choose a liquidity floor or 'no liquidity filter'");
  }
  p.answers.push({ path: "liquidity" });
  return p;
}

// ---- Optional add-ons (docs/prompt-interpreter-spec.md §5.2): off unless switched on ----
export const MIN_PRICE_PHRASE = "minimum price (add-on)";

export function addonState(p: ScreenProgram) {
  const liq = p.conditions.find((x) => x.phrase === LIQUIDITY_PHRASE);
  const px = p.conditions.find((x) => x.phrase === MIN_PRICE_PHRASE);
  return {
    liquidity: { enabled: !!liq, cr: liq && typeof liq.value === "number" ? liq.value : null, suggested_cr: 10 },
    min_price: { enabled: !!px, price: px && typeof px.value === "number" ? px.value : null },
    // there is no ASM/GSM list in the data source, so the switch is shown but cannot be turned on
    asm_gsm: { enabled: false, available: false, reason: "no ASM/GSM list in the data source yet" },
  };
}

export function applyMinPrice(program: ScreenProgram, choice: { mode: "none" } | { mode: "floor"; price: number }): ScreenProgram {
  const p = clone(program);
  const prev = p.conditions.find((c) => c.phrase === MIN_PRICE_PHRASE);
  if (prev) {
    p.conditions = p.conditions.filter((c) => c.id !== prev.id);
    p.sets.forEach((s) => { s.where = dropLeaf(s.where, prev.id); });
    p.answers = p.answers.filter((a) => !a.path.startsWith(`conditions.${prev.id}.`));
  }
  if (choice.mode === "floor") {
    if (!(typeof choice.price === "number" && Number.isFinite(choice.price) && choice.price > 0)) throw new AnswerError("the minimum price must be a positive number of rupees");
    const base = p.sets.find((s) => s.from === "universe");
    if (!base) throw new AnswerError("there is nothing to screen yet — interpret a prompt first");
    const next = p.conditions.reduce((m, c) => Math.max(m, Number(/^C(\d+)$/.exec(c.id)?.[1] ?? 0)), 0) + 1;
    const id = `C${next}`;
    p.conditions.push({ id, lhs: { field: "price" }, op: ">=", value: choice.price, phrase: MIN_PRICE_PHRASE });
    base.where = (base.where as any).all ? { all: [...(base.where as any).all, id] } : { all: [base.where, id] };
    p.answers.push({ path: `conditions.${id}.value` });
  } else if (choice.mode !== "none") throw new AnswerError("choose a minimum price or 'none'");
  return p;
}

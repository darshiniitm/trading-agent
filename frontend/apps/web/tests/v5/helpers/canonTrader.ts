// A compact, order-stable text form of a compiled program, for pinning what a prompt compiles to.
import type { ScreenProgram } from "spec";

const op = (o: any): string => {
  if (!o) return "?";
  if ("field" in o) return `${o.field}${o.params && Object.keys(o.params).length ? `(${Object.values(o.params).join(",")})` : ""}`;
  const p = Object.values(o.params ?? {}).map((v) => (v === null ? "?" : String(v))).join(",");
  return `${o.ind}(${p})${o.output && o.output !== "value" ? `.${o.output}` : ""}@${o.tf ?? "?"}`;
};

export function canonicalTrader(p: ScreenProgram): string[] {
  const out: string[] = [`universe ${p.universe.source === "index" ? p.universe.index : "all"}`];
  for (const c of p.conditions) {
    const rhs = c.rhs ? op(c.rhs) : JSON.stringify(c.value ?? null);
    out.push(`${op(c.lhs)} ${c.op} ${rhs}${c.rhs_mult !== undefined ? ` x${c.rhs_mult}` : ""}${c.within_bars ? ` within ${c.within_bars}` : ""}${c.bars ? ` bars ${c.bars}` : ""}${c.dir ? ` ${c.dir}` : ""}`);
  }
  for (const a of p.actions as any[]) out.push(`action ${a.type}${a.n ? ` n=${a.n}` : ""}${a.by ? ` by=${a.by[0]?.key}/${a.by[0]?.order}` : ""}${a.entry ? ` entry=${a.entry.at}` : ""}${a.stop?.from_atr ? ` stop=${a.stop.from_atr.mult}xATR(${a.stop.from_atr.length})` : ""}${a.target ? ` target=${a.target.r_multiple}R` : ""}${a.highlight?.metric ? ` ${a.highlight.metric}/${a.highlight.lookback_sessions}/top${a.highlight.top_n_per_group}` : ""}`);
  if (p.unsupported.length || p.not_evaluable?.length) out.push(`not evaluated: ${(p.not_evaluable ?? []).map((n) => n.reason).join("; ")}`);
  return out;
}

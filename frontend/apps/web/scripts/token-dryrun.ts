// Token dry run: runs the interpreter on one or more prompts and records every model call per agent.
// No app code is changed: the Ollama HTTP call (global fetch -> /api/chat) is intercepted.
//   MODE=real    (default) pass calls through to your local Ollama and read its exact token counts
//                (prompt_eval_count = input, eval_count = output incl. thinking)
//   MODE=capture no model needed: answer every call with an empty schema-valid JSON and count input
//                tokens with a Gemma tokenizer (TOKENIZER=path to a .mjs exporting count(text))
// Usage (from frontend/apps/web):
//   OLLAMA_MODEL=gemma4:31b npx tsx scripts/token-dryrun.ts TC05            # one golden prompt
//   OLLAMA_MODEL=gemma4:31b npx tsx scripts/token-dryrun.ts all             # all 20
//   OLLAMA_MODEL=gemma4:31b npx tsx scripts/token-dryrun.ts "your prompt text"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { interpret } from "@/server/compiler/v5/interpret";
import { makeClauseFallback } from "@/server/compiler/v5/fallback";
import { makeModelReader } from "@/server/compiler/v5/modelRead";
import { makeReader } from "@/server/compiler/v5/reader";
import { makeModelCritic } from "@/server/compiler/v5/critic";
import { TASK_PROFILES } from "@/server/compiler/callModel";

const MODE = process.env.MODE ?? "real";
type Rec = { prompt: string; task: string; system_chars: number; user_chars: number; schema_chars: number; think: boolean; num_predict?: number;
  input_tokens?: number; output_tokens?: number; thinking_chars?: number; content_chars?: number; ms: number; tokens_source: string };
const recs: Rec[] = [];
let current = "";
let count: ((s: string) => number) | null = null;

const taskOf = (np?: number) => (Object.entries(TASK_PROFILES).find(([, p]) => p.num_predict === np)?.[0] ?? "unknown");

// minimal value that satisfies a JSON schema (capture mode)
function minimal(s: any): any {
  if (!s) return null;
  if (s.anyOf) return minimal(s.anyOf.find((x: any) => x.type === "null") ?? s.anyOf[0]);
  const t = Array.isArray(s.type) ? (s.type.includes("null") ? "null" : s.type[0]) : s.type;
  if (s.enum) return s.enum[0];
  if (t === "object") { const o: any = {}; for (const k of s.required ?? []) o[k] = minimal(s.properties[k]); return o; }
  if (t === "array") return [];
  if (t === "string") return "";
  if (t === "number" || t === "integer") return 0;
  if (t === "boolean") return false;
  return null;
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (!u.includes("/api/chat") || !init?.body) return realFetch(url, init);
  const body = JSON.parse(init.body);
  if (!body.messages?.length) return realFetch(url, init);            // warm-up call
  const [sys, usr] = body.messages;
  const rec: Rec = { prompt: current, task: taskOf(body.options?.num_predict), system_chars: sys.content.length, user_chars: usr.content.length,
    schema_chars: typeof body.format === "object" ? JSON.stringify(body.format).length : 0, think: !!body.think, num_predict: body.options?.num_predict, ms: 0, tokens_source: MODE };
  const t0 = Date.now();
  if (MODE === "capture") {
    rec.input_tokens = count ? count(sys.content) + count(usr.content) + 12 : undefined;   // +12 ≈ chat-template turn markers
    const content = JSON.stringify(minimal(body.format));
    rec.content_chars = content.length; rec.ms = 0; recs.push(rec);
    return new Response(JSON.stringify({ message: { content }, done: true }) + "\n", { status: 200 });
  }
  const res = await realFetch(url, init);
  if (!res.ok || !res.body) { rec.ms = Date.now() - t0; recs.push(rec); return res; }
  // tee the NDJSON stream: the app reads one copy, we read the final chunk's counters from the other
  const [a, b] = res.body.tee();
  (async () => {
    const reader = b.getReader(); const dec = new TextDecoder(); let buf = "", thinking = 0, content = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop()!;
      for (const l of lines) { if (!l.trim()) continue; const c = JSON.parse(l);
        thinking += c.message?.thinking?.length ?? 0; content += c.message?.content?.length ?? 0;
        if (c.done) { rec.input_tokens = c.prompt_eval_count; rec.output_tokens = c.eval_count; } } }
    rec.thinking_chars = thinking; rec.content_chars = content; rec.ms = Date.now() - t0; recs.push(rec);
  })();
  return new Response(a, { status: res.status, headers: res.headers });
}) as typeof fetch;

async function main() {
  if (MODE === "capture" && process.env.TOKENIZER) count = (await import(process.env.TOKENIZER)).count;
  const golden = JSON.parse(readFileSync(path.resolve(process.cwd(), "../../../tests/golden/prompts.json"), "utf8")) as Record<string, string>;
  const arg = process.argv[2] ?? "TC11";
  // set:<tuned|heldout|fresh|blind> = the paraphrase sets in tests/v5/fixtures (prompts worded unlike the 20 golden ones)
  const SETS: Record<string, string> = { tuned: "golden-trader-paraphrases.json", heldout: "golden-trader-heldout.json", fresh: "golden-trader-fresh.json", blind: "golden-trader-blind.json" };
  const fromSet = (n: string): [string, string][] => Object.entries(JSON.parse(readFileSync(path.join(process.cwd(), "tests/v5/fixtures", SETS[n]), "utf8")) as Record<string, string[]>)
    .flatMap(([id, list]) => list.map((t, k) => [`${n}:${id}#${k + 1}`, t] as [string, string]));
  const prompts: [string, string][] = arg === "all" ? Object.entries(golden) : arg.startsWith("set:") ? fromSet(arg.slice(4)) : golden[arg] ? [[arg, golden[arg]]] : [["custom", arg]];
  const perPrompt: any[] = [];
  for (const [id, text] of prompts) {
    current = id; const before = recs.length; const t0 = Date.now();
    let err: string | undefined;
    try {
      const r = await interpret(text, { fallback: makeClauseFallback(), modelRead: makeModelReader(), reader: makeReader(), critic: makeModelCritic(), examples: [] });
      if (process.env.VERBOSE) console.log(r.clauses.map((c) => `  [${c.status}] ${c.text} => ${c.maps_to}`).join("\n") + "\n  english: " + r.english + "\n  not_evaluable: " + JSON.stringify(r.program.not_evaluable ?? []));
    } catch (e) { err = (e as Error).message; }
    await new Promise((r) => setTimeout(r, 200));   // let the last tee finish
    const mine = recs.slice(before);
    const sum = (k: keyof Rec) => mine.reduce((s, r) => s + ((r[k] as number) ?? 0), 0);
    perPrompt.push({ id, calls: mine.length, input: sum("input_tokens"), output: sum("output_tokens"), seconds: (Date.now() - t0) / 1000, error: err });
    console.log(`${id}: ${mine.length} calls, in=${sum("input_tokens")} out=${sum("output_tokens")} ${err ? "ERROR " + err : ""}`);
  }
  const byTask: Record<string, any> = {};
  for (const r of recs) { const t = (byTask[r.task] ??= { calls: 0, input: 0, output: 0, max_input: 0, ms: 0 });
    t.calls++; t.input += r.input_tokens ?? 0; t.output += r.output_tokens ?? 0; t.max_input = Math.max(t.max_input, r.input_tokens ?? 0); t.ms += r.ms; }
  console.table(byTask);
  mkdirSync("../../../results/token_dryrun", { recursive: true });
  const out = `../../../results/token_dryrun/${MODE}_${arg.length > 12 ? "custom" : arg.replace(":", "-")}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify({ mode: MODE, model: process.env.OLLAMA_COMPILER_MODEL ?? process.env.OLLAMA_MODEL, perPrompt, byTask, calls: recs }, null, 2));
  console.log("written", out);
}
main();

# Prompt compiler: any prompt to machine-readable conditions (plan v1)

Status: **P0–P4 implemented 07 Oct 2026** (uncommitted, in the two worktrees; see §9). Plan rev. 11:10 — sample prompt replaced, §1.1 added.
Builds on `docs/prompt-screener-backend-plan.md` (v3.2) and `docs/prompt-screener-frontend-plan.md`.
Code referenced lives in `.claude/worktrees/prompt-screener-frontend/` (Next.js app) and `.claude/worktrees/prompt-screener-engine/` (FastAPI engine).

---

## 0. Why the current compile fails (diagnosis)

The error the app returned for the 5-step brief:

```
source_phrases.2.phrase: Required; source_phrases.3.phrase: Required; source_phrases.4.phrase: Required;
needs_input.0.question: Required; needs_input.1.question: Required; needs_input.2.question: Required
```

`compilations` row 3 (draft 35, `mistral:latest`, 07 Oct 05:23 UTC) shows what happened:

| # | Cause | Where |
|---|---|---|
| F1 | **The local 7B model is asked to write one large free-form JSON object.** Ollama is called with `format: "json"`, which only guarantees *valid JSON*, not *this shape*. Mistral wrote `source_phrases` / `needs_input` items without the `phrase` / `question` keys. Zod rejects, one retry, same mistake, 422. Earlier rows show the same pattern (nulls with mistral, invented values with gemma4). | `compiler/callModel.ts` |
| F2 | **The model is asked to write the user-facing questions.** A question is fully determined by the missing path plus catalog metadata, so it should never come from the model. | `compiler/promptBuilder.ts` rule 3 |
| F3 | **Steps 3–5 of your own brief are classed as "unsupported".** The compiler prompt tells the model that sector outperformance, backtesting and return validation are unsupported. The confirm gate blocks any draft with an unsupported item, **so your original brief can never be confirmed**, even though backend plan §2.2 treats those steps as structure steps. | `promptBuilder.ts` last paragraph vs backend plan §2.2 |
| F4 | **The raw model output is not saved on failure.** Failed compiles store `{"text": null}`, so there is nothing to debug from. | `compileDraft.ts` catch block |
| F5 | **Traceability only checks that a path is listed**, not that the phrase actually occurs in the prompt or contains the value. A model can "source" 14 from the phrase "RSI". | `compiler/traceability.ts` |
| F6 | **The spec can only express 4 catalog items, weekly bars, and `between` / `>=` / `flip`.** Examples 2/3 (daily SMA crossover, Nifty 100, ranking) and 5 ("below") cannot be represented at all, whatever the model does. | `packages/spec/src/index.ts`, `engine/conditions/catalog.py` |

Note: `compile.ts` was edited at 10:54 IST today (a `normalizeNullableModelFields` patch that drops phrase-less source phrases and fills a generic question). The running route bundle predates that edit. It hides F1/F2 but doesn't fix them: dropped source phrases then fail traceability on the retry.

**Conclusion:** patching one model mistake at a time won't converge. The compiler should do the parsing deterministically wherever it can, use the model only for small, schema-constrained pieces, and target a richer intermediate representation (IR) that can express any of the example prompts.

---

## 1. Target: what "any prompt" has to cover

| Example | What it asks for | What the IR needs |
|---|---|---|
| **1. Sample prompt (07 Oct, primary)** — text in §1.1 | universe filter → weekly Friday-close VStop flip + RSI band → group *qualified* stocks by sector + highlight outperformers → trade plan (EP, SL, confidence) on stocks *flipped on VStop* → re-run on previous week, measure this week's return | sets referenced **by description** ("from stocks flipped on VStop 10,2"), a timeframe phrase that scopes the lines below it, events, **actions** (group, trade plan, validate) |
| 1a. earlier numbered version ("from 1", "from stocks in 2") | same, with numeric step references | references **by step number** |
| 1b. same with "RSI Range X to Y" | placeholders | X and Y become questions, never numbers |
| 2. Nifty 100 SMA crossover | index universe from the Nifty Indices CSV, **daily** candles, SMA 6 vs SMA 30, bullish **and** bearish crosses, **rank** by most recent cross date | index universe, timeframe per condition, **indicator vs indicator** comparison, `cross_above` / `cross_below`, rank action |
| 3. (identical to 2) | — | determinism test: same prompt must produce the same IR hash |
| 4. "All stocks between 10K–50K cr" | universe filter only | a program with zero signal conditions is valid (a plain list) |
| 5. "All stocks below  10K cr Market Cap" | universe filter only, one-sided | `mcap_cr < 10000`; "below" = `<` (strictly less). Double spaces are normalised away |
| 5b. edge case: "below 10K–50K cr" (the earlier wording) | contradictory: "below" + a range | a **clarification** with the user's own numbers as options: `< 10,000 cr`, `< 50,000 cr`, `outside 10,000–50,000 cr` |

### 1.1 The sample prompt, clause by clause

```
All stocks between 10K- 50K cr Market Cap
stocks whose friday closing Weekly timeframe
flipped on VStop 10,2
RSI Range 50 to 65
Group qualified stocks by sectors and highlight the Outperforming sectors
From stocks flipped on VStop 10,2  in  build a stratergy with SL and EP and confidence on that trade
Backtest and validate with same strategy on previous week data and validate with their returns in this week
```

| Line | Compiles to | Value status |
|---|---|---|
| All stocks between 10K- 50K cr Market Cap | **S1** = all NSE stocks with mcap 10,000–50,000 cr (C1) | complete |
| stocks whose friday closing Weekly timeframe | eval mode `literal`, `tf: 1W`, completed Friday bar. **Scopes the lines below it** until another timeframe phrase appears | complete |
| flipped on VStop 10,2 | C2: VStop(length 10, mult 2) flips long on that bar | `source` missing → question |
| RSI Range 50 to 65 | C3: RSI between 50 and 65 on that bar | `length` missing → question |
| Group qualified stocks by sectors and highlight the Outperforming sectors | **S2** ("qualified") = S1 ∩ C2 ∩ C3; A1 = group S2 by sector, highlight outperformers | outperformance metric missing → question |
| From stocks flipped on VStop 10,2 in build a stratergy with SL and EP and confidence on that trade | **S3** = S1 ∩ C2 (matched by description: the phrase repeats C2's own words); A2 = trade plan on S3, SL from C2's VStop level | entry point (when EP is taken) and confidence method missing → questions; **set scope ambiguous → question** (below); trailing "in" → ignored |
| Backtest and validate with same strategy on previous week data and validate with their returns in this week | A3 = re-run the whole program at as_of − 1 week; measure 1-week return of the previous week's S3 trade plans | complete (horizon = 1 week, from "this week") |

**The important change from the numbered version.** Before, the trade plan was built on step 2 (VStop flip **and** RSI 50–65). Read literally, this prompt builds it on **every stock flipped on VStop**, with or without RSI 50–65. RSI then only affects which stocks are "qualified" for the sector view. That is a bigger trade set and it **would not match the current Literal arm**, so the P0 parity test would change. The compiler doesn't pick one: it raises an `ambiguous` question with both readings in your words:

> "From stocks flipped on VStop 10,2" — trade plan on (a) all stocks flipped on VStop 10,2, or (b) only qualified stocks (flipped on VStop 10,2 **and** RSI Range 50 to 65)?

Questions this prompt raises (6): VStop source, RSI length, outperformance metric, entry point, confidence method, trade-set scope. Plus the liquidity question (D3). Saved conventions (§8, decision 2) would remove the first two.

---

## 2. The IR: ScreenProgram v5

Replaces `ScreenSpec` v4. Literal and T1-literal stay, as **evaluation modes** inside it, so D1 and the P0 parity test still hold for weekly prompts.

### 2.1 Shape

```json
{
  "program_version": 5,
  "universe": { "source": "nse_all" },
  "sets": [
    { "id": "S1", "from": "universe", "label": "All stocks between 10K- 50K cr Market Cap",
      "where": { "all": ["C1"] } },
    { "id": "S2", "from": "S1", "label": "qualified stocks",
      "eval": { "mode": "literal", "timeframe": "1W", "bar": "last_completed" },
      "where": { "all": ["C2", "C3"] } },
    { "id": "S3", "from": "S1", "label": "stocks flipped on VStop 10,2",
      "eval": { "mode": "literal", "timeframe": "1W", "bar": "last_completed" },
      "where": { "all": ["C2"] } }
  ],
  "conditions": [
    { "id": "C1", "lhs": { "field": "mcap_cr" }, "op": "between", "value": [10000, 50000] },
    { "id": "C2", "lhs": { "ind": "vstop", "params": { "length": 10, "mult": 2, "source": null }, "tf": "1W" },
      "op": "flip", "dir": "long", "within_bars": 1 },
    { "id": "C3", "lhs": { "ind": "rsi", "params": { "length": null }, "tf": "1W" },
      "op": "between", "value": [50, 65] }
  ],
  "actions": [
    { "id": "A1", "type": "group_by", "set": "S2", "key": "sector",
      "highlight": { "metric": null, "rule": null } },
    { "id": "A2", "type": "trade_plan", "set": "S3",
      "entry": { "at": null }, "stop": { "from": "C2" }, "confidence": { "method": null } },
    { "id": "A3", "type": "validate", "of": "program", "shift": { "weeks": -1 }, "horizons_w": [1] }
  ],
  "source_phrases": [ { "path": "conditions.C1.value.0", "phrase": "10K- 50K cr", "span": [19, 30] } ],
  "needs_input":   [
    { "path": "conditions.C2.params.source", "reason": "missing" },
    { "path": "conditions.C3.params.length", "reason": "missing" },
    { "path": "actions.A1.highlight.metric", "reason": "missing" },
    { "path": "actions.A2.entry.at", "reason": "missing" },
    { "path": "actions.A2.confidence.method", "reason": "missing" },
    { "path": "actions.A2.set", "reason": "ambiguous", "options": ["S3", "S2"] }
  ],
  "unsupported":   [],
  "ignored":       [ { "text": "in", "reason": "stray word after a set reference" } ]
}
```

Example 2 as IR (abridged):

```json
"universe": { "source": "index", "index": "NIFTY 100", "list": "niftyindices_csv" },
"conditions": [
  { "id": "C1", "lhs": { "ind": "sma", "params": { "length": 6,  "source": null }, "tf": "1D" },
    "op": "cross_any", "rhs": { "ind": "sma", "params": { "length": 30, "source": null }, "tf": "1D" },
    "within_bars": null, "emit": ["direction", "event_date"] }
],
"actions": [ { "id": "A1", "type": "rank", "set": "S1", "by": [ { "key": "C1.event_date", "order": "desc" } ] } ]
```

### 2.2 Vocabulary

| Part | Values |
|---|---|
| `universe.source` | `nse_all`, `index` (NIFTY 50/100/200/500, Midcap 150, …; list from the Nifty Indices CSV, cached with a dated snapshot), `list` (symbols given in the prompt) |
| operand (`lhs` / `rhs`) | `{field}` (mcap_cr, traded_value_cr, price, volume, sector…), `{ind, params, tf}`, or a number |
| `op` | `>`, `>=`, `<`, `<=`, `between`, `outside`, `flip` (+`dir`), `cross_above`, `cross_below`, `cross_any`, `rising` / `falling` (+`bars`) |
| `tf` | `1D`, `1W`, `1M` — per condition, so mixed timeframes are possible |
| `within_bars` | event lookback: "flipped this week" = 1 weekly bar; "crossed in the last 5 days" = 5 daily bars |
| boolean | `where: {all|any|not: [...]}`, nestable |
| `eval.mode` | `literal` (completed bar), `t1_literal` (rolling window, needs `t1_window`), `latest` (daily screens: last completed daily bar) |
| `actions.type` | `group_by`, `rank`, `trade_plan`, `validate`, `limit` (top N) |

Paths are now keyed by ids (`conditions.C3.params.length`), not array positions, so adding or removing a condition never shifts a pending answer onto the wrong value. The path grammar check in `compile.ts` (prototype-pollution guard) is kept and rewritten for this grammar.

### 2.3 What stays the same

- **D6 holds.** No value is invented or defaulted. Anything missing is a `needs_input` item with no suggested value. Liquidity is still the only app-raised question (D3).
- **Literal / T1-literal** are `eval.mode` values. The 5-step brief stated in full must still reproduce the Literal arm's forward record (P0 parity).
- **Confirm gate**: empty `needs_input`, no `unsupported`, hypothesis filled.

---

## 3. Compiler pipeline (deterministic first, model second)

```
prompt text
  │ 1 normalise          units (K, L, lakh, cr, %), quotes, typos ("stratergy"), whitespace
  │ 2 segment            lines, numbered items, "from 1" / "from stocks in 2" references → clauses with spans
  │ 3 recognise          rule-based recognisers per clause → IR fragments + exact spans
  │ 4 model fallback     only clauses no recogniser claimed; small schema-constrained call per clause
  │ 5 assemble           sets, references, ids, timeframes, eval mode
  │ 6 gap analysis       walk IR against registry → needs_input (reason: missing / placeholder / ambiguous / contradiction)
  │ 7 verify             schema, path grammar, every value traced to a span that contains it
  ▼
draft program + interpretation view
```

### 3.1 Recognisers (step 3)

A library of small TypeScript functions, each returning `{fragment, spans}` or nothing. Each is unit-tested against phrasing variants.

| Recogniser | Matches (examples) | Produces |
|---|---|---|
| `mcapRange` | "between 10K- 50K cr Market Cap", "10,000–50,000 crore", "mcap > 20k cr", "below  10K cr Market Cap" (→ `<`), "above", "under", "over", "at least" (→ `>=`) | `field:mcap_cr` with `between` / `>` / `<` |
| `mcapContradiction` | "below 10K-50K cr" | `needs_input` reason `contradiction` with options built from the user's numbers |
| `indexUniverse` | "Nifty 100", "Nifty Midcap 150 symbols from the official Nifty Indices CSV" | `universe.index` |
| `indicatorMention` | "VStop 10,2", "RSI(14)", "SMA 6 and SMA 30", "EMA 20" | `{ind, params}`; positional numbers mapped by the registry's `positional_params` (vstop: length, mult) |
| `band` | "RSI Range 50 to 65", "RSI between X and Y" | `between` with values or placeholders |
| `event` | "flipped on", "turned long", "crossed above", "bullish and bearish crossovers" | `flip` / `cross_*` |
| `timeframe` | "Friday closing weekly timeframe", "daily candles", "weekly" | `tf` + `eval.mode` |
| `setRef` | by number: "from 1", "from stocks in 2"; **by description**: "from stocks flipped on VStop 10,2", "from stocks in RSI Range 50 to 65", "qualified stocks" | `set.from`. A description is matched to the earlier condition(s) whose own source phrase it repeats; the new set = the base universe ∩ those conditions. "qualified" = every signal condition so far. If the matched set drops a condition the prompt applied earlier, raise an `ambiguous` question (§1.1) |
| `timeframeScope` | "stocks whose friday closing Weekly timeframe" on its own line | applies `tf` + eval mode to every following condition line until another timeframe phrase appears |
| `actions` | "group … by sectors and highlight the outperforming sectors", "SL and EP and confidence", "backtest … previous week … returns in this week", "rank by most recent crossover date first" | `group_by`, `trade_plan`, `validate`, `rank` |
| `noise` | "Read my prompt", "build a … scanner:" | `ignored` |

With these recognisers, all five example prompts compile with **no model call at all**. The model only handles phrasing no recogniser covers.

### 3.2 Model fallback (step 4)

- **One call per unclaimed clause**, not one call for the whole prompt. A 7B model does far better on a 1-line task.
- **Ollama structured outputs**: pass the fragment's JSON Schema as `format` (generated from zod with `zod-to-json-schema`) instead of `format: "json"`. Ollama then constrains decoding to that schema, so missing keys like `phrase` cannot happen (fixes F1).
- Few-shot examples taken from the golden set (§6).
- Its output goes through the same verify step. A phrase must be a substring of the clause.
- If it still fails: the clause is shown as **"not understood"** in the interpretation view, with *rephrase* / *ignore* options. The whole compile no longer fails with a 422.

### 3.3 Questions are templated, never model-written (step 6)

Every `needs_input` item is `{path, reason}`. The question text comes from registry metadata:

| reason | Template | Example |
|---|---|---|
| `missing` | "What {param.label} should {indicator.label} use?" | "What RSI length should RSI use?" |
| `placeholder` | "You wrote {token}. What value should replace it?" | "You wrote X. What is the lower bound of the RSI range?" |
| `ambiguous` | "{phrase} could mean: {options}. Which one?" | "'Friday closing' — evaluate on Friday's close only, or on Monday's open too?" |
| `contradiction` | "'{phrase}' — did you mean {options}?" | "'below 10K-50K cr' — below 10,000 cr, below 50,000 cr, or outside 10,000–50,000 cr?" |

Options are only ever built from the user's own words and numbers, so D6 holds. This removes the `needs_input.N.question: Required` class of error (fixes F2).

### 3.4 Traceability (step 7)

A source phrase is valid only if (a) its span exists in the normalised prompt and (b) the value can be re-parsed from that span (for example, "10K" → 10000). An answer from the user is the only other valid origin (fixes F5).

### 3.5 Interpretation view (frontend)

Before the questions, the user sees their prompt with each clause highlighted and mapped to what it compiled to:

```
All stocks between 10K- 50K cr Market Cap       → S1: Market cap 10,000–50,000 cr          ✓
stocks whose friday closing Weekly timeframe    → weekly, Friday close (applies below)    ✓
flipped on VStop 10,2                           → C2: VStop(10, 2, source ?) flips long    ? 1 question
RSI Range 50 to 65                              → C3: RSI(length ?) between 50 and 65      ? 1 question
Group qualified stocks by sectors …             → A1: group S2 (C2+C3) by sector, highlight ? 1 question
From stocks flipped on VStop 10,2 in build …    → A2: trade plan on S3 (C2 only?)          ? 3 questions
Backtest and validate … previous week …         → A3: re-run 1 week back, 1-week return    ✓
"in"                                            → ignored
```

Each line can be edited inline. This replaces the bare zod error string the UI shows today.

---

## 4. Engine changes (Python)

| Item | Change |
|---|---|
| **Indicator registry** | One module per indicator: `params` schema (type, range, label, `positional_params`), `compute(df) → series`, `events` it supports (flip, cross), `supports_partial_bar`, `can_supply_stop`. `/conditions` is generated from it (still no defaults). Start with: sma, ema, rsi, vstop, atr, macd, supertrend, bollinger, volume_avg, return_n, dist_52w_high |
| **Data** | Daily OHLCV per symbol from the existing fetcher; resample to `W-FRI` and month-end; `as_of` always means the last *completed* bar of the condition's timeframe |
| **Universe providers** | `nse_all` (existing full NSE pull), `index` (Nifty Indices CSVs, cached with a snapshot date for point-in-time correctness), `list` |
| **Evaluator** | Walks `sets` in order; per symbol, evaluates each condition once and caches it. Returns the per-condition 1/0 matrix (the same shape as the flag-matrix plan), the funnel, near misses, and event metadata (`event_date`, `direction`) |
| **Actions** | `group_by` (sector counts + the user-chosen outperformance metric), `rank`, `trade_plan` (EP at the selection point, SL from a `can_supply_stop` condition, confidence by the user-chosen method), `validate` (re-run the same program at `as_of − shift` and measure 1/2/3-week returns; reuses the existing `/validate`) |
| **`/screen`** | Accepts a v5 program. v4 specs are converted by a pure function (tested), so confirmed prompts keep working |

---

## 5. Immediate fixes (Phase 0, before the IR work)

Small, independent, and each one removes a failure you can hit today:

1. **Ollama `format` = JSON Schema** of `CompileOutputSchema` (add `zod-to-json-schema`). Fixes F1.
2. **Generate `needs_input` questions server-side** from the path; drop `question` from the model's schema. Fixes F2.
3. **Recognise the brief's own steps 3–5** (sector grouping, SL/EP/confidence, previous-week validation) as structure steps, not `unsupported`. Fixes F3, so the 5-step brief becomes confirmable.
4. **Save raw model output for every attempt**, success or failure, in `compilations.raw_json`, plus the attempt number. Fixes F4.
5. **Span-checked traceability.** Fixes F5.
6. **Friendly error in the UI**: "Couldn't read 3 parts of your prompt" with the clauses, not zod paths.
7. Reconcile with the 10:54 `normalizeNullableModelFields` edit: keep the null-stripping of partial objects, remove the phrase-dropping and question-filling once 1 and 2 land.

---

## 6. Tests

| Area | Must pass |
|---|---|
| **Sample prompt (07 Oct)** | Compiles to exactly the IR in §2.1: S1/S2/S3, 6 questions (incl. the trade-set scope question), "in" ignored, zero model calls |
| **Golden set** | Examples 1, 1a, 1b, 2, 4, 5 plus ≥ 25 paraphrases (typos, "crore" vs "cr", "Mcap", reordered steps) → expected IR JSON, compared after canonicalisation |
| Determinism | Examples 2 and 3 (identical) → identical program hash, 10 runs in a row |
| Placeholders | "RSI Range X to Y" → two `placeholder` questions, no numbers in the IR |
| One-sided cap | "All stocks below  10K cr Market Cap" → exactly one condition `mcap_cr < 10000`, no questions except liquidity |
| Contradiction | "below 10K-50K cr" → one `contradiction` question with exactly the 3 options built from the user's numbers |
| No invented values | Every leaf value in every golden IR traces to a span or an answer |
| Recogniser coverage | The 5 examples compile with zero model calls |
| Model fallback | With recognisers disabled, the golden set is run against each candidate model; pass rate recorded (see §8, decision 5) |
| Parity (P0) | The sample prompt, with the trade-set question answered "(b) qualified stocks" and the other values matching the Literal arm, reproduces the Literal arm's forward record. Answered "(a)", it is a different arm and is logged as a new Test arm |
| v4 → v5 | Every confirmed v4 spec converts and screens identically |

---

## 7. Build phases

| Phase | Scope | Done when |
|---|---|---|
| **P0** | §5 immediate fixes | The 5-step brief (with stated values) compiles, asks only for the missing values, and can be confirmed |
| **P1** | IR v5 schema in `packages/spec`, normaliser, segmenter, recognisers, templated questions, span traceability, v4 → v5 converter | Golden set passes with zero model calls for the 5 examples |
| **P2** | Engine: indicator registry, daily data + resampling, index universe, generic evaluator, `cross_*` / `outside` / `rising` ops | Example 2 runs end to end on Nifty 100 daily |
| **P3** | Actions: group_by + outperformance, rank, trade_plan, validate on v5 | The full 5-step brief runs end to end and parity holds |
| **P4** | Model fallback per clause with schema-constrained output; interpretation view in the frontend; model evaluation | Paraphrase set pass rate ≥ the threshold you set |

---

## 8. Decisions needed from you

1. **Timeframes beyond weekly.** Example 2 needs daily candles. The current spec hard-codes `1W` and D1 exposes only Literal / T1-literal. Allow daily (and monthly) with a third eval mode `latest`? This plan assumes yes.
2. **Parameter conventions.** Under D6, "SMA 6" with no source and "RSI" with no length each raise a question, so a short prompt can produce 5+ questions. Option: let *you* save conventions once (e.g. source = close, RSI length = 14), stored as `value_origin = 'user_convention'` with the convention's date, shown on every prompt that uses them. They are your answers, given once, not app defaults.
3. **"Outperforming sector" metric.** Candidates: sector's 1-week return vs Nifty 500; sector's share of qualifiers vs its share of the universe; median return of the sector's qualifiers. Ask per prompt, or fix one?
4. **Confidence on a trade.** Candidates: number of conditions met (flag-matrix count); RSI position within the band and distance to SL; historical hit rate of the same setup over the last N weeks.
5. **Compiler model.** Code calls local Ollama (`mistral:latest`, earlier `gemma4`); backend plan §3 says Claude API. With P1 recognisers the model is a fallback only, so a local model may be enough. Pick after the P4 evaluation, or decide now?
6. **Bearish signals.** Example 2 asks for bearish crossovers too. Show them as information only (current long-only engine, `dir: long`), or open short-side trade plans (V7 short side was marked "in" on 16 Sep)?
7. **Trade set for the sample prompt.** Should the trade plan cover (a) every stock flipped on VStop 10,2, or (b) only the qualified stocks that are also in RSI 50–65? (a) is the literal reading and a new arm; (b) matches today's Literal arm. The compiler will ask this per prompt either way; your answer here decides the parity test and the golden-set expectation.


---

## 9. Implementation status (07 Oct 2026)

All five phases are built and tested. Nothing is committed. Code lives in the two worktrees named at the top.

| Phase | Where | Tests |
|---|---|---|
| **P0** §5 fixes 1–7 | `frontend/apps/web/src/server/compiler/` (`callModel`, `compile`, `promptBuilder`, `questions`, `spanCheck`, `steps`), migration `0006`, `compileDraft`, compile route | `compile`, `compiler-regression`, `compiler-p0`, `callModel` |
| **P1** IR + recognisers | `packages/spec/src/program.ts`, `registry.json` (generated from the engine), `compiler/v5/` (`normalise`, `segment`, `recognisers`, `assemble`, `questions`, `verify`, `answer`, `convert`) | `tests/v5/golden`, `answer-convert` |
| **P2** engine | `engine/v5/` (`program`, `registry`, `data`, `universe`, `evaluator`, `run`), `/conditions/v5`, `/screen/v5`, `/convert/v4-to-v5` | `tests/engine/test_v5_engine.py` |
| **P3** actions | `engine/v5/actions.py` (`group_by`, `rank`, `limit`, `trade_plan`, `validate`) | `test_v5_engine.py`, `test_v5_parity.py` |
| **P4** fallback + view | `compiler/v5/fallback.ts`, `goldenSet.ts`, `scripts/eval-compiler-model.ts`, `InterpretationView.tsx`, `compileProgramDraft.ts`, `/api/drafts/:id/program{,/answer,/screen}`, migration `0007` | `fallback`, `program-draft`, `InterpretationView` |

### What was verified

* The 07 Oct sample prompt compiles to exactly the §2.1 IR (S1/S2/S3, the six questions including the trade-set scope question, "in" ignored) with **zero model calls**. Examples 1a, 1b, 2, 3 (10-run hash), 4, 5 and 5b are in the golden set, plus 26 paraphrase cases.
* **P0 parity.** On the real Literal cache, the sample brief answered "(b) qualified stocks" gives an S2 identical to the Literal arm's tickers, with identical EP and SL. The "(a)" reading is a strict superset (S3 ⊇ S2), i.e. a different, larger arm.
* **v4 → v5.** Converted specs screen identically (matching tickers and SL on three real weeks). The TS and Python converters agree on shared fixtures.
* **No look-ahead.** Future-mutation canaries for `validate` and for the sector benchmark. Weekly bars from daily data are used only once complete.

### Model evaluation (§8 decision 5), recognisers off, local Ollama, 26 golden cases

| Model | Pass rate | Time |
|---|---|---|
| `gemma4:latest` | 26/26 (100%) | ~225 s |
| `mistral:latest` | 25/26 (96.2%) | ~74 s |

Reports: `frontend/apps/web/results/compiler-eval/`. Mistral's one miss dropped a stated length (the safe direction: it becomes a question). Early runs showed a model inventing a timeframe the line never stated; the fallback now keeps a timeframe only if the line says it. **The pass-rate threshold is still yours to set** (`EVAL_THRESHOLD=0.9 npx tsx scripts/eval-compiler-model.ts <models>`).

### Deviations and assumptions to confirm

1. **§8 decisions taken as the plan assumed:** daily/monthly allowed (1); no saved conventions, every missing parameter is asked (2); outperformance metric, confidence method and entry point asked per prompt, each with the engine's catalog of choices as options (3, 4); bearish crosses are information only (6); trade set asked per prompt (7); Ollama stays the compiler model (5).
2. **RSI has no `source` parameter** (it asks only for `length`, as the §1.1 table and v4 do); RSI is always on the close.
3. **`flip` with no stated direction means long** (`dir: long`, as in §2.1 and v4). An explicit "short/bearish/down" gives `short`.
4. **A condition carries a `phrase`** (its own words) so "from stocks flipped on VStop 10,2" can be matched to it.
5. **An action line never also creates conditions**, and a line with a validate/trade-plan/group/rank action is claimed by that action.
6. **Outperformance metric** options: sector return vs benchmark, share of qualifiers vs universe, median qualifier return. Each opens its own follow-up questions (lookback, rule). The engine refuses to default a lookback or `n_weeks`.
7. `t1_literal` programs come only from the v4 converter. No recogniser produces a rolling-window prompt yet.
8. Not recognised by rules (go to the model or "not understood"): `return_n`, `dist_52w_high`, `volume_avg` phrasing beyond "average volume N".

### Known gaps

* Index lists need a dated snapshot in `data_cache/index_lists/` (`engine/v5/universe.py:fetch_index_snapshot()` fetches one; it is never called inside a screen or a test).
* `engine/v5` reads the live NSE data through the same environment loader as v4. A real historical `validate` sweep over many weeks has not been run.
* `tests/engine/test_screen_literal.py::test_screen_without_stop_leaves_sl_and_r_null` fails on the current cache because the newest week has zero candidates. It is unrelated to this work (v4 path).

### Update 07 Oct 2026 — VStop now matches TradingView's Pine source

Compared with the Pine v6 "Volatility Stop" script, the Control `src/indicators/vstop.py` differed in two ways (ATR seeding: exponential from bar one vs Pine's SMA-seeded RMA; and warm-up: Control skips bars without an ATR, Pine runs from bar one using the raw true range). On the real weekly cache about 6–13% of tickers had a different stop value, and a handful a different last-bar flip. Since Control is not needed, **v5 now uses `src/indicators/vstop_tv.py`**, a statement-for-statement port (hand-computed test in `tests/engine/test_vstop_tv.py`). `vstop.py` is untouched, so the v4 path and its recorded evidence are unchanged; the v4/v5 parity tests run both sides on the same VStop maths. The Literal grader's trailing-stop view and the chart series now use it too. Not yet compared against TradingView itself on real tickers.

### Update 07 Oct 2026 — v4 removed; every flow runs on v5 programs

Decision: the Control/v4 path is not needed, so the app's flows were rebuilt on v5 and v4 was deleted.

* **Engine** (`prompt-screener-engine`): `/screen`, `/select`, `/validate`, `/arms/register` now take a `program` and return the shapes the app already stores (candidates with membership, entered / watching / no_point_data, graded horizon rows), via `engine/v5/legacy.py`. `/screen/v5` returns the full result (every set, every action). Deleted: `engine/screen.py`, `engine/conditions/`, `engine/validate_spec.py`, `engine/structures.py`, `engine/schemas.py`, `engine/validation.py`, the v4 endpoints (`/conditions`, `/structures`, `/convert/v4-to-v5`) and their tests. `src/` (the project harness) is untouched.
* **App** (`prompt-screener-frontend`): a confirmed prompt's `spec_json` now holds its v5 program (migration not needed). Confirm gate = program fully answered + the app's liquidity question + hypothesis + kill criterion; a condition's origin (`prompt` / `user_answer`) comes from the program's source phrases and answer log. Weekly screen, entry selection, validation, catch-up, versioning, copy and the watchlist view all read the program. **Deleted:** the single-shot model compile, the manual condition form, the answers/compile/dry-run routes, v4 provenance and merge code. `DraftEditor` is now: prompt → Interpret → questions → liquidity → hypothesis / kill criterion → Confirm.
* **Existing prompts keep working:** a stored v4 spec is upgraded on read (`src/server/programOf.ts`, the tested v4→v5 converter). Prompt 1 in the live database is one.
* **Liquidity** is the app's own question (D3): "Yes, ₹10 cr/week", "Yes, my own floor" or "No liquidity filter"; nothing pre-selected. A floor becomes a `traded_value_cr >= N` condition (8W window) on the set that starts from the universe, traced to the user's answer.
* **Verified:** engine 77 tests, web 269 tests, and a live run of confirm → screen → selection → next-week screen → validation gate against the real engine (arm registration stubbed, throwaway database): entries entered with real entry prices and stops below entry, condition values keyed `C1`–`C4`.
* **Not covered by the live run:** a graded `real_read` validation through the app (the engine's own tests cover grading real picks with the TradingView VStop); two harness test files under `tests/` (`test_wow.py`, `test_flags_match_control.py`) fail independently on recorded counts that depend on the data cache.


### Update 11 Oct 2026 — trader-prompt patterns; the 20 golden prompts pass end to end

Before this change the 20 golden trader prompts ("Prompt Screener — Golden Test Cases") compiled to wrong programs and 0/20 reproduced their golden stock lists (the rule recognisers marked misread lines "ok", so the model never ran). Now all 20 compile with **no model calls** and the engine returns exactly the golden lists (`tests/golden/run_golden.py` in the engine worktree; compiler side pinned by `tests/v5/golden-trader-prompts.test.ts`).

* **`compiler/v5/patterns.ts`** reads whole trader phrases before the line recognisers: crosses ("9 EMA crossing above 21 EMA in the last 3 sessions"), "price above the 150 and 200 day SMA", "150 SMA above both ...", "trending up for at least 1 month", "N% above the 52-week low", "within N% of the 52-week high", "a new 52-week high", volume multiples, gap-ups, NR7 / inside day, Bollinger squeeze, MACD / Ichimoku / Supertrend events, RSI crossing a level, "2-period RSI below 10", RS rating, daily turnover, "strong uptrend / pulling back to the 20 EMA", rank by 12-1 momentum, sector rotation, ATR stop and R-multiple target, and "exit when ..." sentences (ignored: the screen lists candidates). A leading number is a length ("50 DMA", "9 EMA"); the universe's own number is not ("Nifty 100 SMA crossover").
* **Implied values are visible, never silent.** A phrase that only implies a value (252 sessions for a year, x1.30 for "30% above", daily bars, an indicator's standard settings) lists it in `assumptions` with the reason; `verify.ts` accepts an untraced value only when it is a listed assumption. New editable-chip paths: `conditions.C#.rhs_mult`, `within_bars`, `bars`.
* **Timeframe.** A stated cue wins ("weekly", "20-week EMA", "DMA", "N-day", "sessions", "today"); inherently daily setups (MACD, Ichimoku, NR7, gaps ...) default to daily as an assumption; everything else stays undecided so a scope line or the user's default settles it, as before.
* **Coverage.** A line that names a universe plus numbers/rule words nothing could read goes to the model fallback and, if still unread, is reported ("part of this line could not be turned into a rule"), so the engine marks its members as partial rather than full matches. A "backtest and validate" sentence no longer swallows the condition words in front of it.
* **Registry / KB.** New engine indicators are knowledge-base entries (`bar`, `high_n`, `low_n`, `gap_up`, `narrow_range`, `inside_day`, `bb_squeeze`, `momentum_skip`, `turnover_avg`; ADX and Ichimoku are now implemented; field `rs_rating`; ops `up_over`, `down_over`) and `registry.json` is regenerated from them. Programs gain `rhs_mult`. The engine client forwards "recognised but not computable" rows (P/E, ROE) as `unsupported`, so TC20 reports 0 fully qualified.
* **Not done:** the model Reader/fallback path was not exercised by this work (the rules read all 20); a run with the local model on paraphrases of these prompts is still open.


### Update 11 Oct 2026 (later) — the local Ollama model as the safety net

Decision: Ollama only (no hosted models). The rules read what they know; the local model reads what they left over.

* **`compiler/v5/leftover.ts`** works out which words of a line no recogniser turned into a rule. It decides two things: *ask* (a number/indicator/rule word is unread, so worth one model question) and *flag* (a comparison word sits next to a subject: if nothing reads it, the line is reported as "part of this line could not be turned into a rule" and the engine shows partial matches). Named strategies ("Minervini's trend template", "Weinstein stage 2", "Connors RSI 2") and titles are consumed as names, so the 20 golden prompts need zero model calls. A line is cut into rule-sized pieces at separators no recogniser used, and the model is asked one short piece at a time.
* **`compiler/v5/modelRead.ts`** — the model answers in the engine's own condition language (price vs indicator, indicator outputs, multiples, windows, flips, "N bars ago", RS rating), not a reduced one. Constrained JSON schema (indicator / op names are enums); each rule validated on its own against the registry (parameters, ranges, outputs, which indicators have which events); the quoted phrase must be found in the line; every number must be in the line or a stated conversion (52 weeks = 252, N% above = 1 + N/100, "twice" = 2) — else it is rejected, the model is told why and asked once more, and good rules are kept. Self-comparisons are rejected, restated rules are dropped, and a model rule inherits the line's timeframe. Everything it adds is listed as an assumption ("read by the local model") the user can edit. Few-shot examples are the compiler's own correct readings turned back into the model's format, so they cannot drift.
* **Failure modes handled:** Ollama unreachable -> the rules' reading stands, `modelError` is reported, unread words flagged; any crossover read by the rules or the model also gets its "still above/below today" companion.
* **Wired in** `compileProgramDraft` (`modelRead: makeModelReader(callModel)`), `interpret`, `compileProgram` (`opts.modelRead`).

**Measured** (`scripts/paraphrase-eval.ts`; each set is the 20 golden prompts reworded by hand; every set except `blind` was used while building the rules, so only `blind` is a fair generalisation number):

| Set | rules only | rules + gemma4 | rules + mistral |
|---|---|---|---|
| 20 golden prompts | 20/20 (no model calls) | 20/20 | |
| tuned (47) | 47/47 | | |
| held-out (24, then used for fixes) | 24/24 | 13/24 before the fixes | 10/24 |
| fresh (22, then used for generic fixes) | 10/22 | 17/22 | |
| **blind (19, run once, no changes after)** | **12/19** | **14/19** | |

`gemma4:latest` clearly beats `mistral:latest` on this task (13 vs 10 on the same set, before the fixes); `gemma4` is the one to use. Remaining misses on the blind set: wording the rules and the model both mis-read in a plausible way (e.g. "near 52-week lows (within 10%)" as >= 0.9 x the low; a weekly "26-week high" read as daily). Model-read rules are labelled, but they are the main residual risk. Not done: a model-based critic pass over model-read rules; larger-model comparison.

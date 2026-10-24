# Prompt interpreter agent: plain English to screen conditions (plan v1)

Status: plan only, 07 Oct 2026. For Claude Code to implement.
Builds on `docs/prompt-compiler-any-prompt-plan.md` (IR v5, D12: no Literal / T1-literal, only the prompt's conditions filter).
Code referenced: `.claude/worktrees/prompt-screener-frontend/frontend/apps/web/src/server/compiler/v5/` (compiler) and `packages/spec/src/registry.json` (indicator list generated from the engine).

---

## 0. Why the Nifty 100 SMA crossover prompt failed

What the interpretation view showed:

| Prompt line | Result |
|---|---|
| Build a Nifty 100 SMA crossover scanner: | ignored |
| Load them | not used |
| Fetch daily historical candles | daily bars (applies below) ✓ |
| Calculate SMA 6 and SMA 30 | not used |
| Detect bullish and bearish crossovers | not used |
| Rank stocks by the most recent crossover date first | A1: rank ? by ?.event_date desc |

The engine already knows SMA (`registry.json` has sma, ema, rsi, vstop, atr, macd, supertrend, bollinger, volume_avg, return_n, dist_52w_high), so this is not a missing indicator. It is a **reading** problem:

| # | Cause | Where |
|---|---|---|
| R1 | **The title line is thrown away.** The noise rule drops any line shaped like "build/create … scanner:". That line carried the universe (Nifty 100) and the intent (SMA crossover). | `recognisers.ts` → `noise()` |
| R2 | **Each line is read alone.** "Calculate SMA 6 and SMA 30" names two indicators but no test, so it is dropped ("an indicator named with nothing to test is not a condition"). "Detect bullish and bearish crossovers" has a test but no indicators, so it is dropped too. The meaning only exists when the two lines are read together. | `recognisers.ts` → `indicators()`; `segment.ts` splits per line |
| R3 | **The model fallback is told to refuse exactly this.** Its rule 5 says a comparison of two indicators is "none", and its operator list has no `cross_*`. | `fallback.ts` |
| R4 | **References aren't resolved.** "Load them" (them = Nifty 100 symbols), "crossovers" (of the SMAs above), "crossover date" (the event of that condition) all point back to earlier lines. Nothing links them, so the rank has no set and no key. | no resolver for pronouns or back-references |
| R5 | **Regex recognisers cover phrasings, not language.** Every new way of saying something needs a new pattern. Procedural English ("load X, fetch Y, calculate Z, detect W, rank by V") is a sequence of steps, not a list of conditions. | design limit of the v5 recogniser approach |

Conclusion: keep the recognisers as fast tools, but put an **agent that reads the whole prompt** in charge, backed by a **local knowledge repository** of parameters, and fill a fixed set of **slots** for every condition.

---

## 1. The slot model (your 5 points)

Every condition the agent builds has these slots. A condition is ready when every slot is filled.

| # | Slot | What it holds | Example (Nifty 100 SMA prompt) |
|---|---|---|---|
| 1 | **Parameter** | which thing is measured: an indicator, a field, or a universe; its settings | SMA, length 6, source ?; SMA, length 30, source ? |
| 2 | **Condition value** | what it is compared with: a number, a band, another parameter, or nothing (for an event) | the other SMA (crossover has no number) |
| 3 | **Trigger point** | *when* the test is checked: which bar, and how far back an event may have happened | last completed daily bar; crossover within ? bars |
| 4 | **Data range** | which candles and how much history: timeframe, lookback needed, as-of date, backtest window | daily candles; ≥ 30 bars of warm-up (derived from SMA 30) |
| 5 | **Operator / rank** | the test, and how results are ordered or cut | `cross_any` (bullish and bearish); rank by crossover date, newest first |

### 1.1 How a slot gets filled (in this order)

1. **The prompt's own words**, with the exact span (as today).
2. **A rule from the knowledge repository** that follows from what was said, not a chosen value. Example: SMA 30 on daily bars needs at least 30 daily bars, so the data range is derived; "crossover" of two SMAs means operator `cross_*`; "bullish and bearish" means `cross_any`.
3. **Your saved conventions** (`userDefaults.ts` already exists), e.g. "source = close". Shown on the line as *your convention*, never as the app's.
4. **An open question for that slot only.** It doesn't block the rest of the prompt (decision 1, §9).

Values never come from the model's guess or from a library default. Library "common values" in the repository (e.g. RSI 14) are shown only as one-tap suggestions on the question (decision 2, §9).

---

## 2. Parameter knowledge repository (local)

A local, versioned catalogue of every parameter the agent can recognise: indicators, fields, universes, operators, trigger phrases and data-range phrases. It is built once from the web, stored in the repo, and refreshed on demand.

### 2.1 What one entry looks like

```yaml
id: sma
kind: indicator
label: Simple Moving Average
category: trend
aliases: [sma, simple moving average, moving average, ma, dma]   # "200 DMA" = SMA 200 on daily bars
unit: price                    # what it can be compared with: price-unit series, not 0-100 oscillators
params:
  - name: length
    type: int
    range: [1, 500]
    positional: 0              # "SMA 6" -> length 6
    aliases: [period, length, days, bars]
    common_values: [5, 10, 20, 50, 100, 200]   # suggestions only, never auto-filled
  - name: source
    type: enum
    values: [open, high, low, close, hl2, hlc3, ohlc4]
    aliases: [on, of, price]
    common_values: [close]
outputs: [value]
operators: [">", ">=", "<", "<=", between, cross_above, cross_below, cross_any, rising, falling]
events: [cross]
warmup_bars: "length"          # rule used to derive the data range slot
references:
  pine: "ta.sma(source, length)"
  talib: SMA
  pandas_ta: sma
engine:
  implemented: true
  function: engine.v5.indicators.sma
provenance:
  sources: [<urls>]
  fetched_at: 2026-10-07
  status: reviewed             # proposed | reviewed | retired
```

Other entry kinds use the same shape:

| Kind | Examples | Extra fields |
|---|---|---|
| `indicator` | sma, ema, rsi, vstop, macd, supertrend, bollinger, atr, adx, stochastic, obv, vwap, ichimoku, donchian | outputs (e.g. macd: line, signal, hist), events |
| `field` | mcap_cr, price, volume, traded_value_cr, sector, pe, roe, 52w high/low, delivery % | unit, data source, update frequency |
| `universe` | NSE all, Nifty 50/100/200/500, Midcap 150, Smallcap 250, F&O stocks, sector indices | list URL (Nifty Indices CSV), snapshot date |
| `operator` | "crosses above", "golden cross", "bullish crossover" → `cross_above`; "death cross", "bearish crossover" → `cross_below`; "between", "in the range", "above", "at least" | which kinds it applies to |
| `trigger` | "Friday close", "weekly close", "today", "this week", "in the last N days", "at Monday open" | bar rule, window rule |
| `data_range` | "daily candles", "weekly", "last 2 years", "since 2019", "52-week" | timeframe, lookback |
| `rank` | "rank by", "sort by", "top 10", "most recent first", "strongest", "highest RSI" | key, order, limit |

### 2.2 Where it comes from (built from the web, stored locally)

| Source | Gives |
|---|---|
| TradingView Pine Script v6 reference (`ta.*` built-ins) | indicator names, parameter names, defaults as published, formulas. Also the parity reference already used for VStop |
| TA-Lib function list (about 150 functions) | indicator catalogue, parameter names and types |
| pandas-ta indicator list | more indicators, aliases, Python implementations the engine can call |
| Nifty Indices constituent CSVs (niftyindices.com) | universe lists with snapshot dates |
| NSE equity list and sector classification | `nse_all`, sector field |
| Chartink-style scanner phrases (public scan descriptions) | how Indian traders actually phrase screens: aliases and operator phrases |

### 2.3 How it is built and kept

- **KB Builder** (a script plus one agent, run on demand, not on every prompt): fetches the sources, extracts entries, merges duplicates (SMA in Pine = SMA in TA-Lib), writes `kb/*.yaml`. Every new entry starts as `proposed`.
- **Review gate**: you (or a test) mark entries `reviewed`. Only reviewed entries are used for matching. Your weekly screener's parameters (VStop, RSI, mcap) are seeded as reviewed on day 1.
- **Single source of truth**: `registry.json` (used by the compiler today) is **generated** from the KB, filtered to `engine.implemented: true`. The engine's `/conditions` reads the same file. No hand-copied lists.
- **Search index**: a small local index (SQLite FTS plus optional embeddings) over labels and aliases, so "simple MA", "6 day moving avg" and "SMA6" all find `sma`.
- **Recognised but not computable**: if a prompt names an entry with `engine.implemented: false` (e.g. Ichimoku), the line shows "recognised: Ichimoku Cloud, not computable yet", not "not understood". It is queued in `kb/requests.md` with the KB entry, ready for Claude Code to implement.

---

## 3. The agentic workflow

A fixed pipeline run by a deterministic **orchestrator** (code, not a model). Models are used only in the two steps that need language understanding; everything else is tools and rules.

```
prompt
  │
  ├─ 1 PRE-ANNOTATE  (tools, no model)   normalise, split, recognisers tag every span they know:
  │                                       numbers, money, timeframes, KB alias hits, operator phrases
  │
  ├─ 2 READER        (model, whole prompt, structured output)
  │                   builds the intent graph: steps, mentions, and links between lines
  │                   ("them" = Nifty 100 symbols; "crossovers" = of SMA 6 and SMA 30;
  │                    "crossover date" = event date of that crossover)
  │
  ├─ 3 GROUNDER      (tools: kb.search, kb.get, parse.*)
  │                   maps each mention to a KB entry and fills slots 1–5 from spans
  │
  ├─ 4 SLOT RESOLVER (rules, no model)
  │                   derives slots from KB rules, applies your conventions,
  │                   opens a question for each slot still empty
  │
  ├─ 5 VERIFIER      (rules, no model)
  │                   schema, spans, KB compatibility, set references,
  │                   coverage: every span is used, ignored with a reason, or flagged
  │
  ├─ 6 CRITIC        (model, small task)
  │                   reads the plain-English rendering of the result next to the prompt
  │                   and lists anything missing, extra or reversed
  │        └─ if issues: back to 2 with the critic's list (max 2 rounds)
  │
  ├─ 7 DRY RUN       (engine)
  │                   runs on the latest as-of: data available? 0 matches? all matches?
  │
  ▼
interpretation view: each line → what it became, with slot status and confidence
```

### 3.1 Step contracts

| Step | Input | Output | Fails how |
|---|---|---|---|
| 1 Pre-annotate | prompt | normalised text, clauses, `annotations[]` (span, type, KB candidates) | never |
| 2 Reader | prompt, annotations, KB summary (names + aliases of reviewed entries), 3–5 similar past prompts with their accepted results | `intent_graph`: `steps[]` (universe / data / compute / test / event / rank / group / trade_plan / validate / note), `mentions[]` with spans, `links[]` (mention → earlier mention or step) | schema-constrained output (Ollama `format` = JSON Schema). A mention without a valid span is dropped and reported |
| 3 Grounder | intent graph | `conditions[]` with slots 1–5, each slot marked `from_prompt` / `missing` | a mention with no KB match → "not understood: <phrase>", with the 3 closest KB entries as suggestions |
| 4 Slot resolver | conditions, KB rules, your conventions | the same, with slots marked `derived` / `your_convention` / `question` | never |
| 5 Verifier | program | pass, or a list of errors | errors go back to step 2 once |
| 6 Critic | prompt, rendered English | `issues[]` (missing / extra / reversed, with the prompt span) | none → done; issues → step 2, max 2 rounds; still issues → shown to you on the line |
| 7 Dry run | program | counts per condition and set, data gaps | shown as warnings, never blocks |

### 3.2 The rendered English (used by the critic and shown to you)

Generated from the program by templates, never by the model, so it always says exactly what will run:

> From **Nifty 100** stocks, on **daily** candles, find stocks where **SMA(6, close)** crossed **SMA(30, close)** in either direction **on the latest completed day [within ? days]**. Rank them by **crossover date, newest first**.

### 3.3 What each model is allowed to do

| Model step | Allowed | Not allowed |
|---|---|---|
| Reader | split into steps, link references, say which words belong together | invent numbers, pick parameters, set defaults |
| Critic | compare two texts and list differences | edit the program |

Numbers and slot values only ever come from spans, KB rules, your conventions or your answers. The verifier enforces this as it does today (`spanCheck.ts`).

---

## 4. Worked example: the Nifty 100 SMA prompt

| Prompt span | Reader (step 2) | Grounder + resolver (steps 3–4) |
|---|---|---|
| Build a Nifty 100 SMA crossover scanner: | **title**: universe mention "Nifty 100", intent "SMA crossover" (no longer noise) | universe = KB `nifty_100` (Nifty Indices CSV, snapshot date) |
| Load them | step `universe`; "them" → Nifty 100 symbols | confirms universe; nothing new |
| Fetch daily historical candles | step `data`, timeframe daily | data range: `1D`; applies to all later steps |
| Calculate SMA 6 and SMA 30 | step `compute`: series A = SMA 6, series B = SMA 30 | slot 1: sma(length 6), sma(length 30); `source` → your convention or question |
| Detect bullish and bearish crossovers | step `event`, links to series A and B; "bullish and bearish" = both directions | slot 5: `cross_any` (KB operator rule); slot 2: rhs = series B; slot 3: last completed daily bar, lookback window → question ("Within how many days should a crossover count?") |
| Rank stocks by the most recent crossover date first | step `rank`, key links to the event above | rank by `C1.event_date`, newest first; no limit stated → no limit |

Result: 1 universe, 1 condition, 1 rank, and **at most 2 questions** (SMA source, crossover lookback). Both disappear once you save conventions for them. The derived data range (≥ 30 daily bars plus the lookback) is shown, not asked.

The 07 Oct sample prompt (VStop + RSI + sector + trade plan + backtest) goes through the same path; its questions are the ones listed in `prompt-compiler-any-prompt-plan.md` §1.1.

---

## 5. Questions policy

- **Only for empty slots.** Never ask the user to add conditions.
- **Not blocking**: the interpretation view and dry run appear straight away; resolved conditions show live counts; pending slots appear as inline chips on their line.
- **One question per slot**, templated from the KB entry (label, unit, range), with the KB's `common_values` as one-tap suggestions when you allow that (decision 2).
- **Extra conditions the agent thinks are relevant** (e.g. "add a liquidity floor?") appear as optional suggestions, off by default. Liquidity keeps its existing confirm step (D3).

---

## 6. Learning loop

- Every edit you make on a line of the interpretation view is stored as `(phrase, what it compiled to, what you changed it to)`.
- New phrasings become KB aliases (`proposed`, for review).
- Accepted prompts and results are added to a few-shot store. The Reader gets the 3–5 most similar ones with each new prompt, so it learns your phrasing.
- Accepted prompts (with your OK) are added to the golden test set.

---

## 7. Model choice

- The Reader needs to follow references across lines. `mistral:latest` (7B) failed at much simpler JSON tasks today. Candidates to test on the golden set: a stronger local model through Ollama (e.g. a 14B–32B instruct model) and the Claude API (backend plan §3 originally specified it).
- All model calls use Ollama structured output (`format` = JSON Schema), temperature 0.
- Decide after the P5 evaluation (decision 4).

---

## 8. Tests and build phases

### 8.1 Tests

| Area | Must pass |
|---|---|
| Golden set | The 5 example prompts, the 07 Oct sample, and ≥ 40 paraphrases (Chartink-style phrasing, plain English, typos, numbered and unnumbered) → expected program |
| Slot accuracy | Per slot (parameter, value, trigger, data range, operator/rank): exact-match rate, reported separately |
| Coverage | No span is left unaccounted (used, ignored with reason, or flagged) |
| Cross-line linking | "Calculate SMA 6 and SMA 30" + "Detect crossovers" → one `cross_*` condition; "them" resolves; rank key resolves |
| No invented values | Every value traces to a span, KB rule, your convention or your answer |
| Determinism | Same prompt → same program hash, 10 runs |
| Critic | Seeded wrong programs (direction flipped, condition dropped) are caught ≥ 90% |
| KB | Every `implemented` entry has an engine function and a test; `registry.json` matches the KB |

### 8.2 Phases

| Phase | Scope | Done when |
|---|---|---|
| **P0 quick fixes** | Noise rule ignores a line only if it has no KB hits (fixes R1); a "compute" line with two indicators followed by a "crossover" line is merged (R2); remove fallback rule 5 and add `cross_*` to its operators (R3); rank key resolves to the latest event condition (R4) | The Nifty 100 SMA prompt compiles to the §4 result |
| **P1 knowledge repository** | KB schema, KB Builder from the §2.2 sources, review status, search index, `registry.json` generated from KB | ≥ 60 indicators, the NSE fields and all Nifty index universes are in the KB; your weekly screener's entries are reviewed |
| **P2 reader + grounder + slots** | Pre-annotate, Reader with intent graph, Grounder with KB tools, slot resolver with conventions | Golden set: example prompts 100%, slot accuracy reported |
| **P3 verifier + critic + dry run** | Coverage check, rendered English, critic loop, dry run | Critic catches seeded errors; interpretation view shows slot status and counts |
| **P4 learning loop + KB curator** | Edit capture, alias proposals, few-shot store; unknown terms researched on the web into `proposed` KB entries | A new phrasing you correct once is understood the next time |
| **P5 evaluation** | Model comparison on the golden set | Model picked against your pass-rate threshold |

---

## 9. Decisions needed from you

1. **Non-blocking results.** When a slot is still open, should the dry run show results for the resolved conditions straight away (marked "partial"), or wait until every slot is filled?
2. **Common values from the KB.** May the question show the KB's common values (e.g. RSI 14, source close) as one-tap suggestions? They are never filled in without your tap.
3. **KB scope for v1.** Technical indicators and price/volume fields only, or also fundamentals (PE, ROE, promoter holding)? Fundamentals need a data source the engine doesn't have yet.
4. **Model for Reader and Critic.** Local only, or the Claude API allowed?
5. **Unknown indicators.** When a prompt names something recognised but not computable, should the agent write the KB entry and an implementation request for Claude Code automatically, or only list it?
6. Still open from the compiler plan: the trade set for the 07 Oct sample (all VStop flips, or only those also in RSI 50–65).

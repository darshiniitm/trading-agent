# Production LLM: Gemma 4 on Google AI Studio (26B primary, 31B on rate limit)

**Status:** plan v1.0, 15 Oct 2026, for Claude Code to implement. Nothing here is built yet.
**Owner decision (Dharmin, 15 Oct 2026):** local version keeps Ollama (`gemma4:31b`). Production calls Gemma 4 through the Gemini API (Google AI Studio key): `gemma-4-26b-a4b-it` first, and switch to `gemma-4-31b-it` when 26B hits its rate limit.
**Supersedes:** §3–§6 (the Hugging Face provider) of `docs/production-deployment-plan.md`. Its §7–§11 (Docker, server, Supabase prod project, cron, backups, go-live) still apply unchanged.

---

## 1. Dry run: what one prompt costs today (measured 15 Oct 2026)

**How it was measured:** `frontend/apps/web/scripts/token-dryrun.ts` (new; no app code changed). It runs the real interpreter (`interpret()` with all four model agents attached) and intercepts every `/api/chat` call. `MODE=capture` answers each call with an empty schema-valid JSON and counts input tokens with the Gemma 3 tokenizer (`@lenml/tokenizer-gemma3`; Gemma 4 uses the same 262K vocabulary, so treat the numbers as ±5%). `MODE=real` sends the calls to Ollama and records its exact `prompt_eval_count` / `eval_count`. Raw results: `results/token_dryrun/*.json`.

### 1.1 Most prompts never call the model

The interpreter is rules-first: recognisers read the prompt, and a model is only asked about words they could not read.

| Prompt set | Prompts | Used the model | Model calls per model-using prompt |
|---|---|---|---|
| 20 golden strategy prompts (`tests/golden/prompts.json`) | 20 | **0** | n/a |
| Tuned paraphrases | 47 | 0 | n/a |
| Held-out paraphrases | 25 | 1 | 2 |
| Fresh paraphrases | 23 | 10 | 2 (one prompt: 3) |
| Blind paraphrases | 20 | 7 | 2 (one prompt: 3) |

So a prompt worded like the ones the recognisers were built on costs **0 tokens**. Unfamiliar wording costs about 2 calls.

### 1.2 Per-agent breakdown

| Agent (`task`) | When it runs | Calls seen | Input tokens / call (measured) | Output cap / call (`num_predict`) | Thinking |
|---|---|---|---|---|---|
| `modelRead` | once per unread phrase ("piece") of a line; 2nd attempt if the answer fails verification | 20 | **2,068 – 2,487 (avg 2,309)** | 3,072 | on |
| `critic` | once per round, only if any model call happened | 18 | **205 – 280 (avg 235)** | 2,048 | on |
| `reader` | once per round, only when a whole line is still unread after `modelRead`; 2 attempts | 0 | 700 – 1,047 (sized from its prompt builder on the 20 golden prompts) | 1,536 | off |
| `fallback` | per line that no recogniser claimed at all; 2 attempts | 0 | 1,113 – 1,212 per line (sized the same way) | 768 | off |
| `curate` | offline knowledge-base build only (`scripts/kb-curate.ts`), **never per user prompt** | n/a | n/a | 3,072 | on |

**Where the input goes:** `modelRead`'s system prompt is ~8,100 characters (≈2,000 tokens: instructions plus 5 worked examples picked by `pickExamples`). That one prompt is ~90% of all input tokens.

### 1.3 Per-prompt totals

| Case | Calls | Input | Output (cap) | Status |
|---|---|---|---|---|
| Rules read everything (typical for familiar wording) | 0 | 0 | 0 | measured |
| Typical model-using prompt: 1 `modelRead` + 1 `critic` | 2 | **~2,550** | ≤ 5,120 | input measured, output pending real run |
| Worst seen: 2 `modelRead` + 1 `critic` | 3 | ~4,850 | ≤ 8,192 | input measured |
| Design worst case: 3-line prompt, every agent, both attempts, 3 critic rounds | ~30 | ~40,000 | ~60,000 | theoretical, never observed |

**Output and thinking tokens are still unmeasured** (my sandbox can't reach Ollama on the Mac). To get them, run this on the Mac with Ollama up:

```
cd ~/Downloads/trading-agent/frontend/apps/web
OLLAMA_MODEL=gemma4:31b npx tsx scripts/token-dryrun.ts set:blind     # the 7 model-using blind prompts give the real per-agent outputs
OLLAMA_MODEL=gemma4:31b npx tsx scripts/token-dryrun.ts TC11          # your own VStop/RSI prompt (rules-only: expect 0 calls)
```

Paste the `byTask` table into §1.2. Until then, budget at the caps above.

### 1.4 What this means against the AI Studio limits

Per model (Dharmin's AI Studio dashboard, 15 Oct 2026): **30 requests/min, 16K tokens/min, 14.4K requests/day**, for each of 26B and 31B.

- **Tokens per minute is the binding limit.** At ~2,550 input per model-using prompt, 26B handles about **6 prompts/min**, and 31B adds about 6 more. If Google counts output and thinking against that 16K too (verify in Phase 0), it drops to about 2–3 per model.
- Requests are not the problem: 30 RPM ÷ 2 calls = 15 prompts/min.
- Daily: 14.4K requests ÷ 2 ≈ 7,000 model-using prompts/day per model.
- No single call comes close to 16K, but the design-worst-case prompt (~40K) would need about 3 minutes of one model's budget. §3.3 fixes that.

---

## 2. Design

One codebase, two configurations, same as the deployment plan: `APP_ENV=local` → Ollama (unchanged), `APP_ENV=production` → Gemini API. The switch stays inside the single model seam, `src/server/compiler/callModel.ts` (`callClaude` → `callOllama`). Nothing else in the app talks to a model.

### 2.1 Config (`src/server/config/llm.ts`, new)

```
APP_ENV              local | production                 (default local)
LLM_PROVIDER         ollama | gemini                    (default: ollama when local, gemini when production)
# Ollama: names unchanged, so local keeps working with no new env vars
OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_COMPILER_MODEL, OLLAMA_THINK_<TASK>, OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX, OLLAMA_WARM
# Gemini API
GEMINI_API_KEY                                          (required when LLM_PROVIDER=gemini; server-side only, never NEXT_PUBLIC_*)
GEMINI_MODELS        ordered list, default "gemma-4-26b-a4b-it,gemma-4-31b-it"   (first = primary)
GEMINI_LIMITS        per model "rpm/tpm/rpd", default "30/16000/14400" for both
GEMINI_TIMEOUT_MS    default 120000
GEMINI_THINK_<TASK>  0|1 override, same meaning as OLLAMA_THINK_<TASK>
```

Fail fast at boot if `APP_ENV=production` with `LLM_PROVIDER=ollama`, or `gemini` without a key. Log the resolved provider and models once (never the key).

### 2.2 `callGemini` (`src/server/compiler/callGemini.ts`, new)

- `@google/genai` SDK, `models.generateContent`, non-streaming (no local cold start to dodge).
- `systemInstruction` = system, `contents` = user, `temperature: 0`, `maxOutputTokens: profile.num_predict`.
- `format` given → `responseMimeType: "application/json"`, `responseSchema` (or `responseJsonSchema`) = the existing zod-derived schema. No `format` → JSON mime type only (mirrors Ollama's `"json"` mode).
- Thinking per `TASK_PROFILES`, via whatever Phase 0 finds works for Gemma (`thinkingConfig` or the Gemma system-prompt toggle). Return **only** the answer text; drop thought parts.
- Read `usageMetadata` (`promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`) on every call and feed the budget tracker (§3) and telemetry (§5).
- Same error style as `callOllama` (`"Gemini request failed (<status>, <model>): …"`).

### 2.3 Dispatcher

`callClaude` (keep the name; tests and callers inject it) becomes: `LLM_PROVIDER === "gemini" ? callGeminiWithFallback(...) : callOllama(...)`. Move `TASK_PROFILES` to a provider-neutral `profiles.ts`. `warmModel()` becomes a no-op on Gemini. Add `modelFor("ollama:gemma4:31b" | "gemini:gemma-4-26b-a4b-it")` next to `ollamaFor` so the eval scripts can target either.

---

## 3. 26B → 31B switching

### 3.1 Budget tracker (`src/server/compiler/rateBudget.ts`, new)

In-process, per model: a 60-second sliding window of requests and tokens, plus a daily request count that resets at the Gemini quota reset (midnight Pacific; confirm in Phase 0).

- Before a call, estimate its cost: `input ≈ chars/4` (the dry run shows this is within ~10% for these prompts; or use the measured per-task averages), plus output = `num_predict` if Phase 0 shows output counts toward TPM.
- **Pick the first model in `GEMINI_MODELS` whose window has room.** 26B is used until the next call would push it over ~90% of RPM or TPM; then 31B.
- If neither has room: wait for the earlier window to free up (max `GEMINI_QUEUE_MS`, default 20 s), then return a clear "busy, try again in a minute" error to the UI. Never fail silently.
- On a daily cap: mark that model exhausted until reset.

### 3.2 Reacting to Google's answer

- **429** (rate limit) on 26B → mark its window full for the `retry-after` time (or 60 s) and resend the same request to 31B at once.
- **5xx / timeout** → one retry on the same model with jittered backoff, then the next model. (So a blip doesn't burn 31B's quota.)
- **400 / other 4xx** → throw immediately; it's our bug, not a limit.
- All model calls for one user prompt try to stay on one model, so a prompt isn't read half by 26B and half by 31B. Switch mid-prompt only on a 429.

### 3.3 Cut tokens before launch (cheap, from the dry run)

1. **Memoise model reads across critic rounds.** `interpret()` re-runs `compileProgram` on each round, which repeats every `fallback` and `modelRead` call on the same text at temperature 0. Same input, same answer, so cache by `(task, system, user)` for the life of one `interpret()` call. Only the `reader` (whose prompt carries the critic's issues) needs a new call. This removes most of the design-worst-case cost.
2. **Trim `modelRead`'s system prompt** (~2,000 tokens, ~90% of input). Test 3 examples instead of 5 (`pickExamples(…, n)`) and a shorter rule list against the blind and fresh sets. Ship whatever keeps the pass rate.
3. **Production round cap:** `maxRounds` 1 instead of 2 in production unless the eval shows round 3 still fixes prompts.
4. **Recogniser coverage is the real lever.** Every phrase taught to the rules is a model call that never happens. Log production prompts that reached the model (§5) and feed them back into the recognisers.

---

## 4. Phase plan

### Phase 0: probe Gemma 4 on the Gemini API (½ day, first)

Dharmin: create the AI Studio API key in the production Google Cloud project; store it as `GEMINI_API_KEY` on the server only. Check AI Studio's current terms on whether free-tier prompts may be used by Google, since user prompts will go through it.

Claude Code: `scripts/gemini-probe.ts`, run for both models:
- plain round-trip, with `systemInstruction`;
- `responseSchema` with each real schema (`CLAUSE_JSON_SCHEMA`, `MODEL_JSON_SCHEMA`, `READER_JSON_SCHEMA`, `CRITIC_JSON_SCHEMA`): does it parse and validate?
- thinking off/on: which mechanism works, and does `thoughtsTokenCount` appear?
- `temperature: 0` and `maxOutputTokens` honoured?
- **Which tokens count toward the 16K TPM** (send a call with a big output, watch the AI Studio dashboard), and what a 429 looks like (body, `retry-after`).

Write `docs/gemini-probe-results.md`. **Exit gate:** both models return schema-valid JSON for all four schemas. If one doesn't, it can't be in the fallback chain. If `responseSchema` doesn't work for Gemma at all, fall back to JSON mode + zod validation + the existing retry-with-errors loop, which every agent already has.

### Phase 1: provider switch + budget tracker (1–2 days)

§2 and §3.1–3.2. Tests (vitest, mirroring `tests/callModel.test.ts`, with injected fetch/SDK):
- request shape (schema, thinking, temperature, max tokens), thought parts stripped;
- tracker picks 26B, moves to 31B at the threshold, queues then errors when both are full, daily exhaustion;
- 429 → immediate switch; 5xx → one retry then switch; 400 → no retry;
- existing tests green with `LLM_PROVIDER` unset (local = Ollama).

### Phase 2: token cuts (½–1 day)

§3.3 items 1–3, each checked with `token-dryrun.ts` (input before/after) and the paraphrase evals (no pass-rate drop).

### Phase 3: quality gate (½–1 day)

Run the same suites on three backends:
```
npx tsx scripts/eval-interpreter-model.ts ollama:gemma4:31b gemini:gemma-4-26b-a4b-it gemini:gemma-4-31b-it
SET=blind  npx tsx scripts/paraphrase-eval.ts   (and fresh, heldout) for each backend
+ the 20 golden prompts end to end (compile → screen)
```
- **Pass bar:** each Gemini model ≥ the Ollama `gemma4:31b` baseline, and no prompt that passes on Ollama fails on Gemini.
- **Test 26B and 31B separately.** The 26B is a mixture-of-experts model with ~4B parameters active per pass; the 31B is dense. If 26B misses conditions that 31B gets, the fix is per task: e.g. `modelRead` on 31B first, `critic` on 26B. `GEMINI_MODELS` becomes per-task (`GEMINI_MODELS_<TASK>`).
- Also run `token-dryrun.ts` against Gemini (add `MODE=gemini`, reading `usageMetadata`) to record real per-agent output and thinking tokens.

### Phase 4: deploy

Unchanged: `docs/production-deployment-plan.md` §7–§9 (Docker image, Mumbai VM, Caddy, Supabase prod project, cron, backups, runbook). Replace `HF_TOKEN`/`HF_PROVIDERS` there with `GEMINI_API_KEY`/`GEMINI_MODELS`. Add to the runbook: how to change the model order, read the budget tracker's state, and what users see when both models are full.

---

## 5. Telemetry

Per model call, in the prompt-details store (prompt ID, prompt, final answer, each agent's output, per the 12 Oct warehouse decision), add: `task`, `provider`, `model`, `input_tokens`, `output_tokens`, `thinking_tokens`, `latency_ms`, `attempt`, `fell_back` (true when 31B served because 26B was limited). Plus, per prompt: number of model calls (0 = rules read it all).

This answers, from production data: how often the model is needed, how often 26B spills to 31B, and whether the 16K TPM is the ceiling users actually hit.

---

## 6. Decisions needed from Dharmin

1. **Free tier or paid tier for production.** Free tier = the 30 RPM / 16K TPM shown, and its data terms. Paid lifts both. Decide after the Phase 0 terms check.
2. **26B-first for every agent, or per task** (e.g. 31B for `modelRead`), decided by Phase 3 evidence.
3. **Busy behaviour:** when both models are full, queue up to ~20 s then show "busy, try again" (recommended), or fall back to rules-only reading with unread words flagged (the app already does this when Ollama is down).

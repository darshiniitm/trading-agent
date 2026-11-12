# Prompt-screener golden tests (real NSE data)

Screen date: Fri 4 Sep 2026 close. Trade-plan entry: Mon 7 Sep 2026 open.
Backtest (TC11): signal Fri 28 Aug, entry Mon 31 Aug, exits 4/11/18 Sep.

Inputs (already in this repo, do not refresh them before a test run):
  data_cache_literal/daily_ohlcv_since_2024-01-01.parquet
  data_cache_literal/shares_outstanding.json
  data_cache/sector/sector_map.parquet
  data_cache/index_lists/<index>/2026-10-09.csv   (today's membership, applied to 4 Sep — the runner pins it)

Files:
  golden.json          expected answers + supporting values (its TC10 is the OLD VStop-brief answer; the CSV is the truth)
  expected/TCxx.csv    one CSV per case — the answers the runner compares against (short_history=1 -> stock listed < 1 year)
  prompts.json         the 20 prompts, exactly as written in the test-case doc
  reference_programs.py hand-written correct programs: proves the ENGINE alone reproduces every golden answer
  programs/TCxx.json   what the COMPILER produced from each prompt (generated, see below)
  run_golden.py        prompt -> program -> engine -> stocks, diffed against the golden answer (+ the universe the prompt names)
  run_reference.py     the same, for the hand-written programs
  ref_indicators.py    independent maths (Wilder RSI/ATR/ADX, Pine v6 VStop + Supertrend, SMA-seeded EMA). Never import app code here.
  compute_golden.py    regenerates golden.json:  python3 compute_golden.py /path/to/trading-agent

Run the whole pipeline (2 steps):
  cd frontend/apps/web
  GOLDEN_DIR=<this repo>/tests/golden NO_MODEL=1 npx tsx scripts/golden-compile.ts     # compiler: prompt text -> programs/
  cd <this repo> && python3 tests/golden/run_golden.py                                  # engine: programs -> stocks vs golden
  python3 tests/golden/run_reference.py                                                 # engine alone, hand-written programs
  python3 -m pytest tests/engine/test_golden_e2e.py                                     # both as tests

Leave NO_MODEL unset to let the local model (Ollama) read lines the rules cannot.
The compiler side is pinned by frontend/apps/web/tests/v5/golden-trader-prompts.test.ts.

Test-case doc (prompts, expected conditions, defaults): "Prompt Screener — Golden Test Cases" in Claude Docs.
Known doc/data differences: TC06's doc text omits "MACD still above its signal line today" (compute_golden.py applies it, so do we).

Robustness (compiler, not engine): frontend/apps/web/scripts/paraphrase-eval.ts compiles hand-reworded versions of the 20 prompts
and checks they give the original's conditions —  SET=heldout|fresh|blind (default: tuned), MODEL=1 MODEL_NAME=gemma4:latest to let
the local model read what the rules cannot.  Use gemma4 (mistral is clearly worse on this task).

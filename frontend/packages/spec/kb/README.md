# Parameter knowledge repository

What the prompt interpreter can recognise: indicators, fields, universes, operators, triggers, data ranges, ranks.
Design: `docs/prompt-agent-interpreter-plan.md` §2. Entries are JSON in `entries/`; schema in `src/kb/schema.ts`.

- **Status.** Every entry is `proposed`, `reviewed` or `retired`. Only `reviewed` entries are used for matching.
  (Exception: the message "recognised: X, not computable yet" also reports `proposed` entries by name — it never builds a rule from one.)
- **Implemented.** `engine.implemented: true` entries are the ones `registry.json` is generated from. Flipping it to true
  requires the engine function to exist.
- **Build.** `npm run kb:build -w packages/spec` writes `src/kb.generated.json` and `src/registry.json`; `kb:check` fails if stale
  (a test also checks). Never edit the generated files.
- **Add a term.** `npx tsx scripts/kb-curate.ts "<term>"` (from `apps/web`) researches it into `entries/curated.json` as `proposed` and
  queues a line in `requests.md`. Review the parameters, ranges and aliases, set `status: reviewed`, then build.
- **Alias proposals** from users' edits sit in the `kb_alias_proposal` table until a person copies the good ones into an entry.
- `provenance.fetched_at: null` means the entry was written from reference docs by hand, not fetched by a tool.

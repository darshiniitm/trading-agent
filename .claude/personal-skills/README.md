# Personal skills

This folder is yours to grow continuously — it's separate from `.claude/skills/` (the 5 formal,
stable skills that describe how the repo's fixed operational cadence works) so you can iterate
on personalization freely without touching or destabilizing those.

Use this for skills about **presentation and interpretation choices**, not underlying
methodology — e.g.:

- "Always show a 4-week rolling view before the full history."
- "Use this color/label scheme for gain vs. loss."
- "When I ask for a quick shortlist, weight `candidate_score`'s guardrail factors this way."
- "Summarize a graded week in this specific structure/length."

## Format

Same shape as the formal skills: `.claude/personal-skills/<name>/SKILL.md` with `name` +
`description` frontmatter, then a procedure.

## The one rule

A personal skill can change **how** a number is displayed or **how** a shortlist is framed. It
must never change **what** gets computed as Control, or silently override a rule in
`.claude/HARNESS.md` (frozen Control, no look-ahead, immutable records, etc.). If a
personalization idea would require bending one of those rules, that's a signal it belongs in
`add-test-arm` instead, not here.

Empty for now — add your first skill here as you find something worth formalizing.

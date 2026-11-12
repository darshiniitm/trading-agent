# Personal agents

Custom subagent definitions (frontmatter `.md` files, invoked via the Agent tool) for
personalized analysis or report-generation personas — e.g. an agent that always drafts
`docs/forward_test_findings.md` entries in your preferred structure/voice, or one that reviews a
new Test-arm proposal against `.claude/HARNESS.md` before you commit to it.

This is separate from `.claude/skills/` and `.claude/personal-skills/` because an agent carries a
*persona* (tone, structure, what it emphasizes) across many invocations, rather than describing
one procedure.

## Format

Standard Claude Code subagent definition: `.claude/personal-agents/<name>.md` with frontmatter
(`name`, `description`, optionally `tools`) and a system-prompt-style body.

## The one rule

An agent's **style** is yours to define freely. The **facts and guardrails** it operates over —
what Control is, what's frozen, what's a known defect, what a term means — must still come from
`.claude/HARNESS.md` and `.claude/GLOSSARY.md`, not from the agent's own invented conventions.
If you want an agent to be strict about this, have its prompt explicitly point back to those two
files rather than restating (and risking drift from) their content.

Empty for now — add your first agent here as you find a recurring style worth formalizing.

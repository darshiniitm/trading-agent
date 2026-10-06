import { CompileOutputSchema, type CompileOutput } from "spec";
import { buildCompilerPrompt, buildRetryUser } from "@/server/compiler/promptBuilder";
import { assertTraceable, UntraceableValueError } from "@/server/compiler/traceability";
import { callClaude } from "@/server/compiler/callModel";

export class CompileError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`compile failed after retrying once: ${errors.join("; ")}`);
    this.errors = errors;
  }
}

type CatalogEntry = { kind: string; name: string; required_params?: { name: string }[] };

function validateAgainstCatalog(output: CompileOutput, catalog: CatalogEntry[]): string[] {
  const errors: string[] = [];
  const byKey = new Map(catalog.map((c) => [`${c.kind}:${c.name}`, c]));

  output.conditions.forEach((cond, i) => {
    const entry = byKey.get(`${cond.kind}:${cond.name}`);
    if (!entry) {
      errors.push(`conditions.${i}: "${cond.kind}:${cond.name}" is not in the catalog — it must go into "unsupported" instead`);
      return;
    }
    for (const p of entry.required_params ?? []) {
      const present = (cond.params ?? {})[p.name] !== undefined;
      const flagged = output.needs_input.some((n) => n.path === `conditions.${i}.params.${p.name}`);
      if (!present && !flagged) errors.push(`conditions.${i}.params.${p.name}: required by the catalog, but neither present nor flagged in needs_input`);
    }
  });

  if (output.needs_input.some((n) => /liquidity/i.test(n.question))) {
    errors.push('needs_input must never ask about liquidity — the app always asks that separately, remove that item');
  }

  return errors;
}

type CallModelFn = (system: string, user: string) => Promise<string>;

export async function compilePrompt(
  promptText: string,
  catalog: CatalogEntry[],
  structures: unknown[],
  { callModel = callClaude }: { callModel?: CallModelFn } = {}
): Promise<{ output: CompileOutput; raw: string; attempts: number }> {
  const { system, user } = buildCompilerPrompt(promptText, catalog, structures);
  let lastErrors: string[] = [];
  let lastRaw = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const userForThisAttempt = attempt === 1 ? user : buildRetryUser(user, lastErrors);
    lastRaw = await callModel(system, userForThisAttempt);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(lastRaw);
    } catch {
      lastErrors = ["response was not valid JSON"];
      continue;
    }

    const parsed = CompileOutputSchema.safeParse(parsedJson);
    if (!parsed.success) {
      lastErrors = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      continue;
    }

    const catalogErrors = validateAgainstCatalog(parsed.data, catalog);
    if (catalogErrors.length > 0) {
      lastErrors = catalogErrors;
      continue;
    }

    try {
      assertTraceable(parsed.data, parsed.data.source_phrases);
    } catch (err) {
      if (err instanceof UntraceableValueError) {
        lastErrors = err.paths.map((p) => `${p}: no source phrase for this number — never invent a value, add it to source_phrases or drop it`);
        continue;
      }
      throw err;
    }

    return { output: parsed.data, raw: lastRaw, attempts: attempt };
  }

  throw new CompileError(lastErrors);
}

// Research an unknown term into a `proposed` knowledge-repository entry (plan §6, P4).
//   npx tsx scripts/kb-curate.ts "chaikin money flow"          # Wikipedia extract + local model
// Appends to packages/spec/kb/entries/curated.json, rebuilds the generated files and queues an
// implementation request in packages/spec/kb/requests.md. The entry is never reviewed or implemented.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { curateTerm, wikipediaSnippet } from "../src/server/compiler/v5/curate";
import { ollamaFor } from "../src/server/compiler/callModel";
import { DEFAULT_COMPILER_MODEL } from "../src/server/compiler/callModel";

const term = process.argv.slice(2).join(" ").trim();
if (!term) { console.error('usage: kb-curate.ts "<term>"'); process.exit(2); }
const kb = path.join(process.cwd(), "..", "..", "packages", "spec", "kb");

async function main() {
  const snippet = await wikipediaSnippet(term);
  if (!snippet) { console.error(`no reference text found for "${term}"`); process.exit(1); }
  const entry = await curateTerm(term, { callModel: ollamaFor(DEFAULT_COMPILER_MODEL), snippet });
  const file = path.join(kb, "entries", "curated.json");
  const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { entries: [] };
  cur.entries.push(entry);
  writeFileSync(file, JSON.stringify(cur, null, 1));
  appendFileSync(path.join(kb, "requests.md"), `- [ ] \`${entry.id}\` (${entry.label}) — recognised, not computable yet. Source: ${snippet.url}. Needs: engine function, parameter review, status -> reviewed.\n`);
  console.log(`proposed ${entry.id}; now run: npm run kb:build -w packages/spec`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });

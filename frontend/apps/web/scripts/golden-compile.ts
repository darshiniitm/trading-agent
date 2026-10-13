// Stage 1 of the golden end-to-end run: compile each of the 20 golden prompts exactly as the app does
// (rules + model Reader/fallback/critic) and write one program per case for the engine runner.
//   GOLDEN_DIR=<engine>/tests/golden npx tsx scripts/golden-compile.ts [TC01 TC02 ...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { interpret } from "../src/server/compiler/v5/interpret";
import { makeReader } from "../src/server/compiler/v5/reader";
import { makeModelCritic } from "../src/server/compiler/v5/critic";
import { makeClauseFallback } from "../src/server/compiler/v5/fallback";
import { callClaude as callOllama } from "../src/server/compiler/callModel";

const dir = process.env.GOLDEN_DIR;
if (!dir) { console.error("set GOLDEN_DIR to the engine's tests/golden"); process.exit(2); }
const prompts: Record<string, string> = JSON.parse(readFileSync(path.join(dir!, "prompts.json"), "utf8"));
const only = process.argv.slice(2);
const noModel = process.env.NO_MODEL === "1";
mkdirSync(path.join(dir!, "programs"), { recursive: true });

async function main() {
  for (const [id, text] of Object.entries(prompts)) {
    if (only.length && !only.includes(id)) continue;
    try {
      const r = await interpret(text, noModel ? {} : { fallback: makeClauseFallback(callOllama), reader: makeReader(callOllama), critic: makeModelCritic(callOllama) });
      writeFileSync(path.join(dir!, "programs", `${id}.json`), JSON.stringify({ program: r.program, english: r.english, issues: r.issues, clauses: r.clauses, reader: r.reader }, null, 1));
      process.stdout.write(".");
    } catch (e) {
      writeFileSync(path.join(dir!, "programs", `${id}.json`), JSON.stringify({ error: (e as Error).message }));
      process.stdout.write("x");
    }
  }
  console.log("\ndone");
}
main();

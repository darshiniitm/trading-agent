// Builds the knowledge repository bundle and the generated registry.
//   npx tsx packages/spec/scripts/kb-build.ts           write src/kb.generated.json + src/registry.json
//   npx tsx packages/spec/scripts/kb-build.ts --check   fail if either differs from what the entries produce
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KbFileSchema, type KbEntry } from "../src/kb/schema";
import { generateRegistry } from "../src/kb/generate";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "kb", "entries");

export function loadEntries(): KbEntry[] {
  const entries: KbEntry[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const parsed = KbFileSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    entries.push(...parsed.data.entries);
  }
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const e of entries) { const k = `${e.kind}:${e.id}`; if (ids.has(k)) problems.push(`duplicate entry ${k}`); ids.add(k); }
  // an alias may name only one reviewed entry of a kind, or matching would be a coin toss
  const owner = new Map<string, string>();
  for (const e of entries.filter((x) => x.provenance.status === "reviewed" && x.kind !== "operator")) {
    for (const a of [...e.aliases, ...("phrases" in e ? e.phrases : [])]) {
      const k = `${e.kind}:${a.toLowerCase()}`;
      if (owner.has(k) && owner.get(k) !== e.id) problems.push(`alias "${a}" names both ${owner.get(k)} and ${e.id}`);
      owner.set(k, e.id);
    }
  }
  // an implemented entry must say which engine function runs it
  for (const e of entries) if (e.kind === "indicator" && e.engine.implemented && !e.engine.function) problems.push(`${e.id}: implemented but no engine function`);
  if (problems.length) throw new Error(problems.join("\n"));
  return entries;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
export function build() {
  const entries = loadEntries();
  return { bundle: json({ entries }), registry: json(generateRegistry(entries)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = build();
  const files: [string, string][] = [[join(root, "src", "kb.generated.json"), out.bundle], [join(root, "src", "registry.json"), out.registry]];
  if (process.argv.includes("--check")) {
    const stale = files.filter(([f, text]) => { try { return readFileSync(f, "utf8") !== text; } catch { return true; } });
    if (stale.length) { console.error("stale generated files:", stale.map(([f]) => f).join(", "), "- run kb-build"); process.exit(1); }
    console.log("kb: generated files are current");
  } else {
    for (const [f, text] of files) writeFileSync(f, text);
    console.log(`kb: wrote ${files.length} files from ${JSON.parse(out.bundle).entries.length} entries`);
  }
}

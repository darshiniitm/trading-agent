// Step 1 — normalise. Everything downstream (spans, source phrases) is measured against the
// normalised text this returns, which the interpretation view shows back to the user.
const TYPOS: [RegExp, string][] = [
  [/\bstratergy\b/gi, "strategy"], [/\bstartegy\b/gi, "strategy"],
  [/\bvolitility\b/gi, "volatility"], [/\bcrossovr\b/gi, "crossover"],
];

export function normalise(raw: string): string {
  const unified = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[   ]/g, " ")
    .replace(/[‐-―−]/g, "-")
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const lines = unified.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  let out = lines.join("\n").replace(/\n{2,}/g, "\n").trim();
  for (const [re, to] of TYPOS) out = out.replace(re, to);
  return out;
}

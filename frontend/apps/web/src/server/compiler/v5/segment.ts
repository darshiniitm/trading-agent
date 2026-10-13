// Step 2 — segment into clauses with exact spans in the normalised text. A numbered item
// ("1.", "2)", "(3)", "Step 4:") keeps its number so "from 2" can refer to it.
export type Clause = { id: string; text: string; start: number; end: number; number: number | null };

const NUMBERED = /^(?:step\s*)?\(?(\d{1,2})[.):]\s+/i;

export function segment(norm: string): Clause[] {
  const clauses: Clause[] = [];
  let offset = 0;
  for (const line of norm.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!line.trim()) continue;
    const m = NUMBERED.exec(line);
    const skip = m ? m[0].length : 0;
    const text = line.slice(skip);
    clauses.push({ id: `L${clauses.length + 1}`, text, start: lineStart + skip, end: lineStart + line.length, number: m ? Number(m[1]) : null });
  }
  return clauses;
}

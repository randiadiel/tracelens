import type { NumberedLine } from "./types.js";

const HYPOTHESIS_PATTERN = /"hypothesis"\s*:\s*"([^"]{1,80})"/;
const MAX_GROUPS = 50;

export function extractHypothesis(text: string): string | null {
  const match = HYPOTHESIS_PATTERN.exec(text);
  return match?.[1] ?? null;
}

export function countHypotheses(lines: NumberedLine[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of lines) {
    const hypothesis = extractHypothesis(line.text);
    if (!hypothesis) {
      continue;
    }
    if (counts[hypothesis] === undefined && Object.keys(counts).length >= MAX_GROUPS) {
      continue;
    }
    counts[hypothesis] = (counts[hypothesis] ?? 0) + 1;
  }
  return counts;
}

export function filterByHypothesis(
  lines: NumberedLine[],
  hypothesis: string,
): NumberedLine[] {
  return lines.filter((line) => extractHypothesis(line.text) === hypothesis);
}

import { clampLine, normalizeLine } from "./normalize.js";
import type {
  AnalysisResult,
  CompactEntry,
  LoopFinding,
  NumberedLine,
} from "./types.js";

export interface AnalyzeOptions {
  maxChars?: number;
  maxLineChars?: number;
  minLoopOccurrences?: number;
  maxPatternLength?: number;
  normalize?: boolean;
}

interface Run {
  signature: string;
  sample: string;
  count: number;
  fromLine: number;
  toLine: number;
}

interface Cycle {
  patternLength: number;
  occurrences: number;
  startIndex: number;
}

function signaturesMatch(
  values: string[],
  start: number,
  pattern: string[],
): boolean {
  if (start < 0 || start + pattern.length > values.length) {
    return false;
  }
  return pattern.every((value, index) => values[start + index] === value);
}

function findTrailingCycle(
  signatures: string[],
  minOccurrences: number,
  maxPatternLength: number,
): Cycle | undefined {
  let best: Cycle | undefined;
  const maxLength = Math.min(
    maxPatternLength,
    Math.floor(signatures.length / minOccurrences),
  );

  for (let patternLength = 1; patternLength <= maxLength; patternLength += 1) {
    const pattern = signatures.slice(-patternLength);
    let occurrences = 1;
    let cursor = signatures.length - patternLength * 2;

    while (signaturesMatch(signatures, cursor, pattern)) {
      occurrences += 1;
      cursor -= patternLength;
    }

    if (occurrences < minOccurrences) {
      continue;
    }

    const candidate = {
      patternLength,
      occurrences,
      startIndex: signatures.length - patternLength * occurrences,
    };
    const covered = candidate.patternLength * candidate.occurrences;
    const bestCovered = best ? best.patternLength * best.occurrences : 0;
    if (
      covered > bestCovered ||
      (covered === bestCovered && patternLength < (best?.patternLength ?? Infinity))
    ) {
      best = candidate;
    }
  }

  return best;
}

function makeRuns(
  lines: NumberedLine[],
  signatures: string[],
  maxLineChars: number,
): Run[] {
  const runs: Run[] = [];

  lines.forEach((line, index) => {
    const signature = signatures[index] ?? "";
    const previous = runs.at(-1);
    if (previous?.signature === signature) {
      previous.count += 1;
      previous.toLine = line.number;
      return;
    }
    runs.push({
      signature,
      sample: clampLine(line.text, maxLineChars),
      count: 1,
      fromLine: line.number,
      toLine: line.number,
    });
  });

  return runs;
}

function runToEntry(run: Run): CompactEntry {
  return {
    kind: run.count > 1 ? "repeat" : "line",
    line: run.sample,
    count: run.count > 1 ? run.count : undefined,
    fromLine: run.fromLine,
    toLine: run.toLine,
  };
}

function estimateEntryChars(entry: CompactEntry): number {
  return (
    90 +
    (entry.line?.length ?? 0) +
    (entry.pattern?.reduce((sum, line) => sum + line.length, 0) ?? 0)
  );
}

function fitToBudget(
  entries: CompactEntry[],
  maxChars: number,
): { entries: CompactEntry[]; omittedLines: number; truncated: boolean } {
  const selected: CompactEntry[] = [];
  let used = 500;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const cost = estimateEntryChars(entry);
    if (selected.length > 0 && used + cost > maxChars) {
      break;
    }
    selected.unshift(entry);
    used += cost;
  }

  const selectedLines = selected.reduce(
    (sum, entry) => sum + entry.toLine - entry.fromLine + 1,
    0,
  );
  const allLines = entries.reduce(
    (sum, entry) => sum + entry.toLine - entry.fromLine + 1,
    0,
  );

  return {
    entries: selected,
    omittedLines: Math.max(0, allLines - selectedLines),
    truncated: selected.length < entries.length,
  };
}

export function analyzeLines(
  source: string,
  lines: NumberedLine[],
  options: AnalyzeOptions = {},
): AnalysisResult {
  const maxChars = options.maxChars ?? 12_000;
  const maxLineChars = options.maxLineChars ?? 600;
  const minLoopOccurrences = options.minLoopOccurrences ?? 4;
  const maxPatternLength = options.maxPatternLength ?? 20;
  const signatures = lines.map((line) =>
    options.normalize === false ? stripForComparison(line.text) : normalizeLine(line.text),
  );
  const runs = makeRuns(lines, signatures, maxLineChars);
  const cycle = findTrailingCycle(
    signatures,
    minLoopOccurrences,
    maxPatternLength,
  );

  let loop: LoopFinding = { detected: false };
  let entries: CompactEntry[] = runs.map(runToEntry);

  if (cycle && lines.length > 0) {
    const cycleLines = lines.slice(cycle.startIndex);
    const first = cycleLines[0];
    const last = cycleLines.at(-1);
    const rawPattern = lines
      .slice(cycle.startIndex, cycle.startIndex + cycle.patternLength)
      .map((line) => clampLine(line.text, maxLineChars));

    if (first && last) {
      const prefixRuns = makeRuns(
        lines.slice(0, cycle.startIndex),
        signatures.slice(0, cycle.startIndex),
        maxLineChars,
      ).map(runToEntry);
      const kind = cycle.patternLength === 1 ? "consecutive" : "cycle";
      loop = {
        detected: true,
        kind,
        confidence: cycle.occurrences >= minLoopOccurrences * 2 ? "high" : "medium",
        occurrences: cycle.occurrences,
        linesCovered: cycleLines.length,
        pattern: rawPattern,
        message:
          kind === "consecutive"
            ? `The same normalized log line repeats ${cycle.occurrences} times at the end.`
            : `A ${cycle.patternLength}-line cycle repeats ${cycle.occurrences} times at the end.`,
        startLine: first.number,
        endLine: last.number,
      };
      entries = [
        ...prefixRuns,
        {
          kind: "cycle",
          fromLine: first.number,
          toLine: last.number,
          pattern: rawPattern,
          occurrences: cycle.occurrences,
        },
      ];
    }
  } else {
    const largestRun = runs.reduce<Run | undefined>(
      (largest, run) => (!largest || run.count > largest.count ? run : largest),
      undefined,
    );
    if (largestRun && largestRun.count >= minLoopOccurrences) {
      loop = {
        detected: true,
        kind: "burst",
        confidence:
          largestRun.count >= minLoopOccurrences * 2 ? "high" : "medium",
        occurrences: largestRun.count,
        linesCovered: largestRun.count,
        pattern: [largestRun.sample],
        message: `A normalized log line repeats ${largestRun.count} consecutive times.`,
        startLine: largestRun.fromLine,
        endLine: largestRun.toLine,
      };
    }
  }

  const fitted = fitToBudget(entries, maxChars);
  const representedLines = fitted.entries.reduce(
    (sum, entry) => sum + entry.toLine - entry.fromLine + 1,
    0,
  );

  return {
    source,
    summary: {
      linesRead: lines.length,
      linesReturned: representedLines,
      entriesReturned: fitted.entries.length,
      repeatedLinesCollapsed: Math.max(0, representedLines - fitted.entries.length),
      omittedLines: fitted.omittedLines,
      outputTruncated: fitted.truncated,
    },
    loop,
    entries: fitted.entries,
  };
}

function stripForComparison(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

import { clampLine, normalizeLine, normalizeNumbers } from "./normalize.js";
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

function enforceSerializedBudget(
  result: AnalysisResult,
  maxChars: number,
): AnalysisResult {
  while (JSON.stringify(result).length > maxChars && result.entries.length > 1) {
    const removed = result.entries.shift();
    if (!removed) {
      break;
    }
    const removedLines = removed.toLine - removed.fromLine + 1;
    result.summary.linesReturned -= removedLines;
    result.summary.entriesReturned -= 1;
    result.summary.omittedLines += removedLines;
    result.summary.outputTruncated = true;
  }

  let patternTruncated = false;
  while (
    JSON.stringify(result).length > maxChars &&
    (result.loop.pattern?.length ?? 0) > 1
  ) {
    result.loop.pattern?.pop();
    patternTruncated = true;
  }
  if (patternTruncated) {
    result.loop.message = `${result.loop.message ?? "Loop detected"} Pattern sample truncated.`;
  }

  const lastEntry = result.entries.at(-1);
  if (
    JSON.stringify(result).length > maxChars &&
    lastEntry?.line &&
    lastEntry.line.length > 120
  ) {
    lastEntry.line = clampLine(lastEntry.line, 120);
  }
  const loopSample = result.loop.pattern?.[0];
  if (
    JSON.stringify(result).length > maxChars &&
    loopSample &&
    loopSample.length > 120 &&
    result.loop.pattern
  ) {
    result.loop.pattern[0] = clampLine(loopSample, 120);
  }
  if (JSON.stringify(result).length > maxChars && result.source.length > 120) {
    result.source = `…${result.source.slice(-119)}`;
  }

  result.summary.repeatedLinesCollapsed = Math.max(
    0,
    result.summary.linesReturned - result.summary.entriesReturned,
  );
  return result;
}

function largestRun(runs: Run[]): Run | undefined {
  return runs.reduce<Run | undefined>(
    (largest, run) => (!largest || run.count > largest.count ? run : largest),
    undefined,
  );
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
  const normalizeEnabled = options.normalize !== false;
  const baseSignatures = lines.map((line) =>
    normalizeEnabled ? normalizeLine(line.text) : stripForComparison(line.text),
  );

  let signatures = baseSignatures;
  let runs = makeRuns(lines, signatures, maxLineChars);
  let cycle = findTrailingCycle(signatures, minLoopOccurrences, maxPatternLength);
  let burst = cycle ? undefined : largestRun(runs);
  if (burst && burst.count < minLoopOccurrences) {
    burst = undefined;
  }
  let largestRepeatObserved = largestRun(runs)?.count ?? 0;
  let numericFallback = false;

  // Standard normalization only masks known dynamic keys. Counters with other
  // names (e.g. {"n":42}) still produce unique signatures, so when nothing was
  // found, retry once with all numeric literals masked.
  if (!cycle && !burst && normalizeEnabled) {
    const numericSignatures = baseSignatures.map(normalizeNumbers);
    const numericRuns = makeRuns(lines, numericSignatures, maxLineChars);
    const numericCycle = findTrailingCycle(
      numericSignatures,
      minLoopOccurrences,
      maxPatternLength,
    );
    let numericBurst = numericCycle ? undefined : largestRun(numericRuns);
    if (numericBurst && numericBurst.count < minLoopOccurrences) {
      numericBurst = undefined;
    }
    largestRepeatObserved = Math.max(
      largestRepeatObserved,
      largestRun(numericRuns)?.count ?? 0,
    );
    if (numericCycle || numericBurst) {
      signatures = numericSignatures;
      runs = numericRuns;
      cycle = numericCycle;
      burst = numericBurst;
      numericFallback = true;
    }
  }

  const fallbackNote = numericFallback
    ? " (Found after masking numeric values; rerun with normalizeDynamicValues=false to see raw lines.)"
    : "";

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
        confidence:
          !numericFallback && cycle.occurrences >= minLoopOccurrences * 2
            ? "high"
            : "medium",
        occurrences: cycle.occurrences,
        linesCovered: cycleLines.length,
        pattern: rawPattern,
        message:
          (kind === "consecutive"
            ? `The same normalized log line repeats ${cycle.occurrences} times at the end.`
            : `A ${cycle.patternLength}-line cycle repeats ${cycle.occurrences} times at the end.`) +
          fallbackNote,
        startLine: first.number,
        endLine: last.number,
      };
      entries = [
        ...prefixRuns,
        {
          kind: "cycle",
          fromLine: first.number,
          toLine: last.number,
          occurrences: cycle.occurrences,
        },
      ];
    }
  } else if (burst) {
    loop = {
      detected: true,
      kind: "burst",
      confidence:
        !numericFallback && burst.count >= minLoopOccurrences * 2
          ? "high"
          : "medium",
      occurrences: burst.count,
      linesCovered: burst.count,
      pattern: [burst.sample],
      message: `A normalized log line repeats ${burst.count} consecutive times.${fallbackNote}`,
      startLine: burst.fromLine,
      endLine: burst.toLine,
    };
  } else {
    loop = {
      detected: false,
      message:
        lines.length === 0
          ? "Loop detection ran but there were no lines to scan."
          : `Loop detection ran on ${lines.length} lines; the largest consecutive repeat of a normalized line was ${largestRepeatObserved} (threshold: ${minLoopOccurrences}).`,
      linesScanned: lines.length,
      minOccurrencesRequired: minLoopOccurrences,
      largestRepeatObserved,
    };
  }

  const fitted = fitToBudget(entries, maxChars);
  const representedLines = fitted.entries.reduce(
    (sum, entry) => sum + entry.toLine - entry.fromLine + 1,
    0,
  );

  const result: AnalysisResult = {
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
  return enforceSerializedBudget(result, maxChars);
}

function stripForComparison(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

import { describe, expect, it } from "vitest";
import { analyzeLines } from "../src/analyze.js";
import type { NumberedLine } from "../src/types.js";

function numbered(values: string[]): NumberedLine[] {
  return values.map((text, index) => ({ number: index + 1, text }));
}

describe("analyzeLines", () => {
  it("collapses repeated lines with changing timestamps", () => {
    const lines = numbered(
      Array.from(
        { length: 8 },
        (_, index) =>
          `2026-08-04T06:00:0${index}.000Z WARN retrying connection attempt=${index}`,
      ),
    );

    const result = analyzeLines("app", lines);

    expect(result.loop).toMatchObject({
      detected: true,
      kind: "consecutive",
      occurrences: 8,
      linesCovered: 8,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      kind: "cycle",
      occurrences: 8,
      fromLine: 1,
      toLine: 8,
    });
  });

  it("detects and compresses a trailing multi-line cycle", () => {
    const lines = numbered([
      "server started",
      "polling queue",
      "queue empty",
      "polling queue",
      "queue empty",
      "polling queue",
      "queue empty",
      "polling queue",
      "queue empty",
    ]);

    const result = analyzeLines("worker", lines);

    expect(result.loop).toMatchObject({
      detected: true,
      kind: "cycle",
      occurrences: 4,
      linesCovered: 8,
      pattern: ["polling queue", "queue empty"],
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.at(-1)?.kind).toBe("cycle");
  });

  it("collapses ingested lines whose JSON metadata carries a loop counter", () => {
    const lines = numbered(
      Array.from(
        { length: 8 },
        (_, index) =>
          `2026-08-05T05:00:00.000Z DEBUG poll tick {"iter":${index + 1}}`,
      ),
    );

    const result = analyzeLines("poller", lines);

    expect(result.loop).toMatchObject({
      detected: true,
      kind: "consecutive",
      confidence: "high",
      occurrences: 8,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.summary.repeatedLinesCollapsed).toBe(7);
  });

  it("falls back to numeric masking for counters with unknown key names", () => {
    const lines = numbered(
      Array.from(
        { length: 8 },
        (_, index) =>
          `2026-08-05T05:00:00.000Z DEBUG worker heartbeat {"n":${index + 1},"queued":0}`,
      ),
    );

    const result = analyzeLines("worker", lines);

    expect(result.loop).toMatchObject({
      detected: true,
      kind: "consecutive",
      confidence: "medium",
      occurrences: 8,
    });
    expect(result.loop.message).toContain("masking numeric values");
    expect(result.entries).toHaveLength(1);
  });

  it("skips the numeric fallback when normalization is disabled", () => {
    const lines = numbered(
      Array.from({ length: 8 }, (_, index) => `poll tick iter=${index + 1}`),
    );

    const result = analyzeLines("raw", lines, { normalize: false });

    expect(result.loop.detected).toBe(false);
    expect(result.entries).toHaveLength(8);
  });

  it("keeps ordinary numeric differences distinct", () => {
    const result = analyzeLines(
      "http",
      numbered(["response status 200", "response status 500", "response status 200"]),
    );

    expect(result.loop.detected).toBe(false);
    expect(result.entries).toHaveLength(3);
  });

  it("explains itself when no loop is detected", () => {
    const result = analyzeLines(
      "quiet",
      numbered(["server started", "listening on port 3000", "listening on port 3000"]),
    );

    expect(result.loop).toMatchObject({
      detected: false,
      linesScanned: 3,
      minOccurrencesRequired: 4,
      largestRepeatObserved: 2,
    });
    expect(result.loop.message).toContain("Loop detection ran on 3 lines");
  });

  it("returns newest entries within the context budget", () => {
    // Letter-based suffixes keep lines unique even under numeric masking.
    const lines = numbered(
      Array.from(
        { length: 100 },
        (_, index) =>
          `unique log ${index.toString().replace(/\d/g, (d) => "abcdefghij"[Number(d)] ?? "z")} ${"x".repeat(80)}`,
      ),
    );

    const result = analyzeLines("large", lines, {
      maxChars: 1_000,
      maxLineChars: 200,
    });

    expect(result.summary.outputTruncated).toBe(true);
    expect(result.summary.omittedLines).toBeGreaterThan(0);
    expect(result.entries.at(-1)?.toLine).toBe(100);
  });

  it("bounds a long repeating pattern to the requested budget", () => {
    const pattern = Array.from(
      { length: 20 },
      (_, index) => `cycle step ${index} ${"details ".repeat(80)}`,
    );
    const result = analyzeLines("verbose-worker", numbered([...pattern, ...pattern, ...pattern]), {
      maxChars: 1_000,
      maxLineChars: 2_000,
      minLoopOccurrences: 3,
      maxPatternLength: 20,
    });

    expect(result.loop.detected).toBe(true);
    expect(result.loop.message).toContain("Pattern sample truncated");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_000);
  });
});

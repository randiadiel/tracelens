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

  it("keeps ordinary numeric differences distinct", () => {
    const result = analyzeLines(
      "http",
      numbered(["response status 200", "response status 500", "response status 200"]),
    );

    expect(result.loop.detected).toBe(false);
    expect(result.entries).toHaveLength(3);
  });

  it("returns newest entries within the context budget", () => {
    const lines = numbered(
      Array.from({ length: 100 }, (_, index) => `unique log ${index} ${"x".repeat(80)}`),
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

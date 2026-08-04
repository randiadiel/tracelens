import { describe, expect, it } from "vitest";
import { analyzePerformance } from "../src/performance.js";
import type { NumberedLine } from "../src/types.js";

function numbered(values: string[]): NumberedLine[] {
  return values.map((text, index) => ({ number: index + 1, text }));
}

describe("analyzePerformance", () => {
  it("groups routes, converts units, and ranks bottlenecks", () => {
    const result = analyzePerformance(
      "api",
      numbered([
        "GET /users/101 duration=100ms",
        "GET /users/102 duration=900ms",
        "GET /users/103 duration=1.1s",
        "POST /orders completed in 2s",
        'operation="db.users" duration_ms=42',
      ]),
      { slowThresholdMs: 500 },
    );

    expect(result.summary).toMatchObject({
      timingSamples: 5,
      operationsFound: 3,
      slowSamples: 3,
    });
    expect(result.bottlenecks[0]).toMatchObject({
      operation: "POST /orders",
      maxMs: 2_000,
      severity: "critical",
    });
    expect(result.bottlenecks.find((entry) => entry.operation === "GET /users/:id")).toMatchObject({
      samples: 3,
      averageMs: 700,
      p95Ms: 1_100,
    });
    expect(result.outliers.map((entry) => entry.durationMs)).toEqual([2_000, 1_100, 900]);
  });

  it("summarizes CPU, memory, and event-loop pressure", () => {
    const result = analyzePerformance(
      "worker",
      numbered([
        "metrics cpu_percent=72 memory_mb=512 event_loop_lag=40ms",
        "metrics cpu_percent=95 memory_mb=768 event_loop_lag=140ms",
      ]),
    );

    expect(result.resources).toMatchObject({
      cpuPercent: { samples: 2, peak: 95, peakLine: 2 },
      memoryMb: { samples: 2, peak: 768, peakLine: 2 },
      eventLoopLagMs: { samples: 2, peak: 140, peakLine: 2 },
    });
    expect(result.findings).toContain("CPU saturation is likely; observed peak is 95%.");
    expect(result.findings).toContain("Event-loop delay is elevated; p95 is 140 ms.");
  });

  it("explains how to instrument logs when timings are absent", () => {
    const result = analyzePerformance("plain", numbered(["worker started", "queue empty"]));

    expect(result.summary.timingSamples).toBe(0);
    expect(result.findings[0]).toContain("No recognized timing fields");
  });
});

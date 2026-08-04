import { clampLine, normalizeLine } from "./normalize.js";
import type { NumberedLine } from "./types.js";

interface TimingSample {
  operation: string;
  durationMs: number;
  line: number;
  sample: string;
}

interface MetricSample {
  value: number;
  line: number;
}

interface OperationStats {
  operation: string;
  samples: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  totalMs: number;
  severity: "normal" | "slow" | "critical";
  slowestLine: number;
}

export interface PerformanceOptions {
  slowThresholdMs?: number;
  maxOperations?: number;
  maxOutliers?: number;
  maxChars?: number;
}

export interface PerformanceAnalysis {
  source: string;
  summary: {
    linesScanned: number;
    timingSamples: number;
    operationsFound: number;
    slowSamples: number;
    resourceSamples: number;
    outputTruncated: boolean;
  };
  bottlenecks: OperationStats[];
  outliers: Array<{
    operation: string;
    durationMs: number;
    line: number;
    sample: string;
  }>;
  resources: {
    cpuPercent?: { samples: number; peak: number; p95: number; peakLine: number };
    memoryMb?: { samples: number; peak: number; p95: number; peakLine: number };
    eventLoopLagMs?: { samples: number; peak: number; p95: number; peakLine: number };
  };
  findings: string[];
}

const KEYED_DURATION =
  /["']?(duration|elapsed|latency|response[_ ]?time|execution[_ ]?time)(?:_?ms)?["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|milliseconds?|s|sec(?:onds?)?)?/i;
const NATURAL_DURATION =
  /\b(?:took|completed in|finished in|responded in)\s+(\d+(?:\.\d+)?)\s*(ns|us|µs|ms|milliseconds?|s|sec(?:onds?)?)\b/i;
const CPU = /["']?cpu(?:_percent|Percent)?["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)\s*%?/i;
const MEMORY =
  /["']?(memory|memory_mb|rss|heap_used|heapUsed)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?/i;
const EVENT_LOOP =
  /["']?(event[_ ]?loop[_ ]?(?:lag|delay)|eventLoopLag)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)\s*(us|µs|ms|s)?/i;

function round(value: number): number {
  return Number(value.toFixed(2));
}

function toMilliseconds(value: number, unit = "ms"): number {
  const normalized = unit.toLowerCase();
  if (normalized === "ns") return value / 1_000_000;
  if (normalized === "us" || normalized === "µs") return value / 1_000;
  if (normalized === "s" || normalized.startsWith("sec")) return value * 1_000;
  return value;
}

function toMegabytes(value: number, unit = "mb"): number {
  const normalized = unit.toLowerCase();
  if (normalized === "b") return value / 1_000_000;
  if (normalized === "kb" || normalized === "kib") return value / 1_000;
  if (normalized === "gb" || normalized === "gib") return value * 1_000;
  return value;
}

function percentile(sorted: number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function normalizePath(value: string): string {
  return value
    .split("/")
    .map((segment) =>
      /^\d+$/.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(segment)
        ? ":id"
        : segment,
    )
    .join("/");
}

function operationFromLine(line: string): string {
  const explicit = line.match(
    /["']?(?:operation|op|route|endpoint|span|task|job|query|name)["']?\s*[:=]\s*["']?([^"',}\s]+)/i,
  );
  if (explicit?.[1]) {
    return clampLine(normalizePath(explicit[1]), 120);
  }

  const http = line.match(
    /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s?"']+)/i,
  );
  if (http?.[1] && http[2]) {
    return `${http[1].toUpperCase()} ${normalizePath(http[2])}`;
  }

  const sql = line.match(
    /\b(SELECT(?:\s+.+?\s+FROM)?|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([`"\w.-]+)/i,
  );
  if (sql?.[1] && sql[2]) {
    const verb = sql[1].toUpperCase().startsWith("SELECT") ? "SELECT" : sql[1].toUpperCase();
    return `SQL ${verb} ${sql[2].replace(/[`"]/g, "")}`;
  }

  const withoutTiming = normalizeLine(line)
    .replace(KEYED_DURATION, "")
    .replace(NATURAL_DURATION, "")
    .replace(/^<timestamp>\s+(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return clampLine(withoutTiming || "unknown operation", 120);
}

function extractDuration(line: string): number | undefined {
  const keyed = line.match(KEYED_DURATION);
  if (keyed?.[2]) {
    const keyDeclaresMs = /(?:_ms|durationMs|elapsedMs|latencyMs)/i.test(
      keyed[0].split(/[:=]/)[0] ?? "",
    );
    return toMilliseconds(
      Number(keyed[2]),
      keyed[3] ?? (keyDeclaresMs ? "ms" : "ms"),
    );
  }
  const natural = line.match(NATURAL_DURATION);
  return natural?.[1]
    ? toMilliseconds(Number(natural[1]), natural[2] ?? "ms")
    : undefined;
}

function metricSummary(samples: MetricSample[]) {
  if (samples.length === 0) return undefined;
  const sorted = samples.map((sample) => sample.value).sort((a, b) => a - b);
  const peak = samples.reduce((current, sample) =>
    sample.value > current.value ? sample : current,
  );
  return {
    samples: samples.length,
    peak: round(peak.value),
    p95: round(percentile(sorted, 95)),
    peakLine: peak.line,
  };
}

function aggregateOperations(
  samples: TimingSample[],
  threshold: number,
): OperationStats[] {
  const grouped = new Map<string, TimingSample[]>();
  for (const sample of samples) {
    grouped.set(sample.operation, [...(grouped.get(sample.operation) ?? []), sample]);
  }

  return [...grouped.entries()].map(([operation, operationSamples]) => {
    const values = operationSamples
      .map((sample) => sample.durationMs)
      .sort((a, b) => a - b);
    const total = values.reduce((sum, value) => sum + value, 0);
    const maxSample = operationSamples.reduce((current, sample) =>
      sample.durationMs > current.durationMs ? sample : current,
    );
    const p95 = percentile(values, 95);
    return {
      operation,
      samples: values.length,
      averageMs: round(total / values.length),
      p50Ms: round(percentile(values, 50)),
      p95Ms: round(p95),
      p99Ms: round(percentile(values, 99)),
      maxMs: round(maxSample.durationMs),
      totalMs: round(total),
      severity:
        p95 >= threshold * 4 || maxSample.durationMs >= threshold * 10
          ? "critical"
          : p95 >= threshold
            ? "slow"
            : "normal",
      slowestLine: maxSample.line,
    };
  });
}

function enforceBudget(
  analysis: PerformanceAnalysis,
  maxChars: number,
): PerformanceAnalysis {
  while (JSON.stringify(analysis).length > maxChars && analysis.outliers.length > 1) {
    analysis.outliers.pop();
    analysis.summary.outputTruncated = true;
  }
  while (JSON.stringify(analysis).length > maxChars && analysis.bottlenecks.length > 1) {
    analysis.bottlenecks.pop();
    analysis.summary.outputTruncated = true;
  }
  while (JSON.stringify(analysis).length > maxChars && analysis.findings.length > 1) {
    analysis.findings.pop();
    analysis.summary.outputTruncated = true;
  }
  return analysis;
}

export function analyzePerformance(
  source: string,
  lines: NumberedLine[],
  options: PerformanceOptions = {},
): PerformanceAnalysis {
  const threshold = options.slowThresholdMs ?? 500;
  const maxOperations = options.maxOperations ?? 10;
  const maxOutliers = options.maxOutliers ?? 10;
  const maxChars = options.maxChars ?? 12_000;
  const timings: TimingSample[] = [];
  const cpu: MetricSample[] = [];
  const memory: MetricSample[] = [];
  const eventLoop: MetricSample[] = [];

  for (const line of lines) {
    const duration = extractDuration(line.text);
    if (duration !== undefined && Number.isFinite(duration) && duration >= 0) {
      timings.push({
        operation: operationFromLine(line.text),
        durationMs: duration,
        line: line.number,
        sample: clampLine(line.text, 300),
      });
    }

    const cpuMatch = line.text.match(CPU);
    if (cpuMatch?.[1]) cpu.push({ value: Number(cpuMatch[1]), line: line.number });
    const memoryMatch = line.text.match(MEMORY);
    if (memoryMatch?.[2]) {
      memory.push({
        value: toMegabytes(Number(memoryMatch[2]), memoryMatch[3]),
        line: line.number,
      });
    }
    const eventLoopMatch = line.text.match(EVENT_LOOP);
    if (eventLoopMatch?.[2]) {
      eventLoop.push({
        value: toMilliseconds(Number(eventLoopMatch[2]), eventLoopMatch[3]),
        line: line.number,
      });
    }
  }

  const allOperations = aggregateOperations(timings, threshold).sort(
    (a, b) => b.p95Ms - a.p95Ms || b.totalMs - a.totalMs,
  );
  const outliers = [...timings]
    .filter((sample) => sample.durationMs >= threshold)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, maxOutliers)
    .map((sample) => ({
      operation: sample.operation,
      durationMs: round(sample.durationMs),
      line: sample.line,
      sample: sample.sample,
    }));
  const resources = {
    cpuPercent: metricSummary(cpu),
    memoryMb: metricSummary(memory),
    eventLoopLagMs: metricSummary(eventLoop),
  };
  const findings: string[] = [];
  const slowest = allOperations[0];
  if (slowest) {
    findings.push(
      `${slowest.operation} has the highest p95 latency (${slowest.p95Ms} ms across ${slowest.samples} samples).`,
    );
  }
  const highestImpact = [...allOperations].sort((a, b) => b.totalMs - a.totalMs)[0];
  if (highestImpact && highestImpact.operation !== slowest?.operation) {
    findings.push(
      `${highestImpact.operation} consumes the most observed time (${highestImpact.totalMs} ms total).`,
    );
  }
  if (resources.cpuPercent && resources.cpuPercent.peak >= 90) {
    findings.push(`CPU saturation is likely; observed peak is ${resources.cpuPercent.peak}%.`);
  }
  if (resources.eventLoopLagMs && resources.eventLoopLagMs.p95 >= 100) {
    findings.push(
      `Event-loop delay is elevated; p95 is ${resources.eventLoopLagMs.p95} ms.`,
    );
  }
  if (timings.length === 0) {
    findings.push(
      "No recognized timing fields found. Log duration, elapsed, latency, response_time, or messages such as 'completed in 120ms'.",
    );
  }

  return enforceBudget(
    {
      source,
      summary: {
        linesScanned: lines.length,
        timingSamples: timings.length,
        operationsFound: allOperations.length,
        slowSamples: timings.filter((sample) => sample.durationMs >= threshold).length,
        resourceSamples: cpu.length + memory.length + eventLoop.length,
        outputTruncated: allOperations.length > maxOperations,
      },
      bottlenecks: allOperations.slice(0, maxOperations),
      outliers,
      resources,
      findings,
    },
    maxChars,
  );
}

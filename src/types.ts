export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogInput {
  message: string;
  level?: LogLevel;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface NumberedLine {
  number: number;
  text: string;
}

export interface ReadResult {
  lines: NumberedLine[];
  totalBytes: number;
  bytesRead: number;
  truncatedAtStart: boolean;
  source: string;
}

export interface LoopFinding {
  detected: boolean;
  kind?: "consecutive" | "cycle" | "burst";
  confidence?: "medium" | "high";
  occurrences?: number;
  linesCovered?: number;
  pattern?: string[];
  message?: string;
  startLine?: number;
  endLine?: number;
}

export interface CompactEntry {
  kind: "line" | "repeat" | "cycle";
  line?: string;
  count?: number;
  fromLine: number;
  toLine: number;
  pattern?: string[];
  occurrences?: number;
}

export interface AnalysisResult {
  source: string;
  summary: {
    linesRead: number;
    linesReturned: number;
    entriesReturned: number;
    repeatedLinesCollapsed: number;
    omittedLines: number;
    outputTruncated: boolean;
  };
  loop: LoopFinding;
  entries: CompactEntry[];
}

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
  /** Present when detected is false: how many lines were checked. */
  linesScanned?: number;
  /** Present when detected is false: the occurrence threshold that applied. */
  minOccurrencesRequired?: number;
  /** Present when detected is false: closest repeat found below the threshold. */
  largestRepeatObserved?: number;
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

export interface TraceLensServerContext {
  transport: "stdio" | "http";
  host?: string;
  port?: number;
  authRequired?: boolean;
  /**
   * True when HTTP ingest routes are reachable at host:port while the MCP
   * transport is stdio — either this process bound the companion listener or
   * another TraceLens process already serves the port (shared on-disk store).
   */
  ingestHttp?: boolean;
}

export interface TraceLensToolGuide {
  name: string;
  summary: string;
}

export interface TraceLensSnippet {
  language: string;
  code: string;
}

export interface TraceLensInstrumentation {
  mode: "http" | "file";
  howTo: string;
  snippets: TraceLensSnippet[];
  rules: string[];
}

export interface TraceLensServerInfo {
  service: "tracelens";
  version: string;
  transport: "stdio" | "http";
  workflow: string[];
  instrumentation: TraceLensInstrumentation;
  tools: TraceLensToolGuide[];
  ingest: {
    mcpTool: string;
    httpUrlTemplate: string | null;
    httpExample: string | null;
    authHeader: string | null;
    logFormat: {
      message: string;
      level?: LogLevel;
      timestamp?: string;
      metadata?: Record<string, unknown>;
    };
    batchFormats: string[];
  };
  endpoints: {
    mcp: string | null;
    health: string | null;
  };
  storage: {
    dataDir: string;
    sources: Array<{ name: string; bytes: number; updatedAt: string }>;
  };
  fileInspection: {
    allowedRoots: string[];
    note: string;
  };
  environment: {
    TRACELENS_ALLOWED_ROOTS: string | null;
    TRACELENS_DATA_DIR: string | null;
    TRACELENS_TOKEN: boolean;
  };
}

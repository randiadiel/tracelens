import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeLines } from "./analyze.js";
import { normalizeLine } from "./normalize.js";
import { readTail } from "./read.js";
import { LogStore } from "./store.js";
import type { LogInput, ReadResult } from "./types.js";

const levelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
const logSchema = z.object({
  message: z.string().min(1).max(100_000),
  level: levelSchema.optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function readTarget(
  store: LogStore,
  input: { source?: string; path?: string; tailLines: number },
): Promise<ReadResult> {
  if (Boolean(input.source) === Boolean(input.path)) {
    throw new Error("Provide exactly one of source or path.");
  }
  return input.source
    ? store.read(input.source, input.tailLines)
    : readTail(input.path as string, input.tailLines);
}

export function createTraceLensServer(store = new LogStore()): McpServer {
  const server = new McpServer({
    name: "tracelens",
    version: "1.0.0",
  });

  server.registerTool(
    "list_log_sources",
    {
      title: "List log sources",
      description:
        "List logs previously pushed into TraceLens. Use inspect_logs with a returned source name.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      try {
        return jsonResult({ sources: await store.list() });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "ingest_logs",
    {
      title: "Ingest logs",
      description:
        "Append structured logs to a named local source. Applications should normally use POST /ingest/:source instead.",
      inputSchema: {
        source: z.string().min(1).max(80),
        logs: z.array(logSchema).min(1).max(1_000),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ source, logs }) => {
      try {
        const appended = await store.append(source, logs as LogInput[]);
        return jsonResult({ source, appended });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "inspect_logs",
    {
      title: "Inspect compact logs",
      description:
        "Read the tail of an ingested source or allowed local file. Collapses repeated lines and trailing cycles, reports likely infinite loops, and enforces a response budget.",
      inputSchema: {
        source: z.string().min(1).max(80).optional(),
        path: z.string().min(1).max(4_096).optional(),
        tailLines: z.number().int().min(10).max(100_000).default(5_000),
        maxChars: z.number().int().min(1_000).max(30_000).default(12_000),
        maxLineChars: z.number().int().min(100).max(2_000).default(600),
        normalizeDynamicValues: z.boolean().default(true),
        minLoopOccurrences: z.number().int().min(3).max(100).default(4),
        maxPatternLength: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => {
      try {
        const read = await readTarget(store, input);
        const analysis = analyzeLines(read.source, read.lines, {
          maxChars: input.maxChars,
          maxLineChars: input.maxLineChars,
          minLoopOccurrences: input.minLoopOccurrences,
          maxPatternLength: input.maxPatternLength,
          normalize: input.normalizeDynamicValues,
        });
        return jsonResult({
          ...analysis,
          read: {
            totalBytes: read.totalBytes,
            bytesRead: read.bytesRead,
            truncatedAtStart: read.truncatedAtStart,
          },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_logs",
    {
      title: "Search logs",
      description:
        "Search recent logs and return compact context around the newest matches. Repeated matching context is collapsed before it reaches the model.",
      inputSchema: {
        source: z.string().min(1).max(80).optional(),
        path: z.string().min(1).max(4_096).optional(),
        query: z.string().min(1).max(1_000),
        regex: z.boolean().default(false),
        caseSensitive: z.boolean().default(false),
        tailLines: z.number().int().min(10).max(100_000).default(20_000),
        maxMatches: z.number().int().min(1).max(200).default(50),
        contextLines: z.number().int().min(0).max(20).default(2),
        maxChars: z.number().int().min(1_000).max(30_000).default(10_000),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => {
      try {
        const read = await readTarget(store, input);
        const flags = input.caseSensitive ? "" : "i";
        const expression = input.regex
          ? new RegExp(input.query, flags)
          : undefined;
        const query = input.caseSensitive ? input.query : input.query.toLowerCase();
        const matches = read.lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) =>
            expression
              ? expression.test(line.text)
              : (input.caseSensitive ? line.text : line.text.toLowerCase()).includes(query),
          );
        const selectedMatches = matches.slice(-input.maxMatches);
        const indexes = new Set<number>();
        for (const match of selectedMatches) {
          for (
            let index = Math.max(0, match.index - input.contextLines);
            index <= Math.min(read.lines.length - 1, match.index + input.contextLines);
            index += 1
          ) {
            indexes.add(index);
          }
        }
        const context = [...indexes]
          .sort((a, b) => a - b)
          .flatMap((index) => {
            const line = read.lines[index];
            return line ? [line] : [];
          });
        const analysis = analyzeLines(`${read.source} search`, context, {
          maxChars: input.maxChars,
        });
        return jsonResult({
          query: input.query,
          totalMatchesInWindow: matches.length,
          matchesReturned: selectedMatches.length,
          normalizedMatchSignatures: [
            ...new Set(selectedMatches.map(({ line }) => normalizeLine(line.text))),
          ].slice(0, 20),
          context: analysis,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

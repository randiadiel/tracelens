import { configuredRoots } from "./read.js";
import type { LogStore } from "./store.js";
import type { TraceLensServerContext, TraceLensServerInfo } from "./types.js";

const VERSION = "0.0.2";

const TOOL_GUIDES = [
  {
    name: "tracelens_info",
    summary:
      "Returns this guide plus live server endpoints, storage paths, and ingested sources. Call first when unsure.",
  },
  {
    name: "list_log_sources",
    summary: "List logs previously pushed into TraceLens.",
  },
  {
    name: "ingest_logs",
    summary:
      "Append structured logs to a named local source through MCP. Prefer HTTP ingest when the server runs in HTTP mode.",
  },
  {
    name: "inspect_logs",
    summary:
      "Tail an ingested source or allowed local file. Collapses repeats, detects loops, and enforces a response budget.",
  },
  {
    name: "search_logs",
    summary:
      "Search recent logs and return compact context around the newest matches.",
  },
  {
    name: "analyze_performance",
    summary:
      "Extract latency and resource metrics, group operations, and rank bottlenecks.",
  },
] as const;

const WORKFLOW = [
  "Call tracelens_info to learn endpoints, auth, storage, and available sources.",
  "Push logs with POST /ingest/:source in HTTP mode, or ingest_logs over MCP in stdio mode.",
  "Call list_log_sources to confirm what is available.",
  "Use inspect_logs, search_logs, or analyze_performance with exactly one of source or path.",
] as const;

export const TRACE_LENS_INSTRUCTIONS = [
  "TraceLens is a context-efficient log debugger for AI agents.",
  "Call tracelens_info first when you need endpoints, ingest URLs, auth, or a tool overview.",
  "Applications should push logs to TraceLens; agents should inspect, search, and analyze them.",
  "Use exactly one of source (ingested JSONL) or path (allowed local file) with inspection tools.",
].join(" ");

function httpBaseUrl(context: TraceLensServerContext): string | null {
  if (context.transport !== "http" || !context.host || !context.port) {
    return null;
  }
  return `http://${context.host}:${context.port}`;
}

export async function buildTraceLensInfo(
  store: LogStore,
  context: TraceLensServerContext,
): Promise<TraceLensServerInfo> {
  const baseUrl = httpBaseUrl(context);
  const authRequired = context.authRequired ?? false;
  const ingestUrlTemplate = baseUrl ? `${baseUrl}/ingest/{source}` : null;
  const authHeader = authRequired ? "Authorization: Bearer <TRACELENS_TOKEN>" : null;

  return {
    service: "tracelens",
    version: VERSION,
    transport: context.transport,
    workflow: [...WORKFLOW],
    tools: [...TOOL_GUIDES],
    ingest: {
      mcpTool: "ingest_logs",
      httpUrlTemplate: ingestUrlTemplate,
      httpExample: baseUrl
        ? [
            `curl -X POST ${baseUrl}/ingest/my-api \\`,
            "  -H 'content-type: application/json' \\",
            authHeader ? `  -H '${authHeader}' \\` : "",
            `  -d '{"level":"error","message":"database connection failed","metadata":{"attempt":3}}'`,
          ]
            .filter(Boolean)
            .join("\n")
        : null,
      authHeader,
      logFormat: {
        message: "human-readable log line",
        level: "error",
        timestamp: "2026-08-04T10:00:00.000Z",
        metadata: { route: "GET /api/users", duration_ms: 842 },
      },
      batchFormats: [
        '{"logs":[{"message":"first"},{"message":"second"}]}',
        '[{"message":"first"},{"message":"second"}]',
      ],
    },
    endpoints: {
      mcp: baseUrl ? `${baseUrl}/mcp` : null,
      health: baseUrl ? `${baseUrl}/health` : null,
    },
    storage: {
      dataDir: store.directory,
      sources: await store.list(),
    },
    fileInspection: {
      allowedRoots: configuredRoots(),
      note: "Provide path only for files under TRACELENS_ALLOWED_ROOTS; otherwise use source for ingested logs.",
    },
    environment: {
      TRACELENS_ALLOWED_ROOTS: process.env.TRACELENS_ALLOWED_ROOTS ?? null,
      TRACELENS_DATA_DIR: process.env.TRACELENS_DATA_DIR ?? null,
      TRACELENS_TOKEN: Boolean(process.env.TRACELENS_TOKEN),
    },
  };
}

import { configuredRoots } from "./read.js";
import type { LogStore } from "./store.js";
import type {
  TraceLensInstrumentation,
  TraceLensServerContext,
  TraceLensServerInfo,
} from "./types.js";

const VERSION = "0.0.3";

const TOOL_GUIDES = [
  {
    name: "tracelens_info",
    summary:
      "Returns the debugging playbook, ready-to-paste instrumentation snippets with the live ingest URL, storage paths, and ingested sources. Call first when unsure.",
  },
  {
    name: "list_log_sources",
    summary:
      "List logs previously pushed into TraceLens. Use after reproducing to confirm your instrumented logs arrived.",
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
      "Search recent logs and return compact context around the newest matches. Search your hypothesis id to pull only your instrumented evidence.",
  },
  {
    name: "analyze_performance",
    summary:
      "Extract latency and resource metrics, group operations, and rank bottlenecks. Requires an operation name and a timing field in metadata.",
  },
] as const;

const DEBUGGING_PLAYBOOK = [
  "1. HYPOTHESIZE — Read the failing code and state one falsifiable hypothesis, e.g. 'H1: cart total is wrong because applyDiscount receives a stale price'. Decide exactly what logged value would confirm or refute it. Do not instrument before you can name the hypothesis.",
  "2. GET ENDPOINTS — Call tracelens_info and copy the exact ingest URL (HTTP mode) or the log-file convention (stdio mode) from the instrumentation section. Never guess the URL or port.",
  "3. INSTRUMENT — Edit the user's code and add log calls at the few points that decide the hypothesis: entry/exit of the suspect function, branch decisions, and the specific variable values involved. Use the snippet from tracelens_info verbatim, substituting message and metadata. Every log must carry metadata.hypothesis (e.g. 'H1') so it can be found and cleaned up later. For performance questions also include an operation name and a duration_ms (or similar) timing field.",
  "4. REPRODUCE — Run the failing scenario, test, or request so the instrumented code actually executes. If nothing runs, no logs will exist.",
  "5. INSPECT — Call list_log_sources to confirm the source appeared, then search_logs with query set to the hypothesis id (e.g. 'H1') for targeted evidence, inspect_logs to tail the wider context, or analyze_performance for latency/CPU/memory questions.",
  "6. VERDICT — If the evidence confirms the hypothesis, implement the fix and re-run step 4-5 to verify the logs now show correct behavior. If it refutes it, write H2 and repeat from step 3 with new targeted instrumentation. Do not blindly widen logging; each iteration tests one hypothesis.",
  "7. CLEAN UP — After the fix is verified, remove every instrumentation call you added (search the codebase for 'tracelens' and your hypothesis ids).",
] as const;

const INSTRUMENTATION_RULES = [
  "Tag every instrumented log with metadata.hypothesis (H1, H2, ...) so search_logs can isolate it and cleanup is greppable.",
  "Instrument the few lines that decide the hypothesis, not the whole codebase.",
  "Logging must never break the app: fire-and-forget, swallow errors, short timeouts.",
  "Use one kebab-case source name per app or debug session, e.g. 'checkout-service'.",
  "Put facts in metadata (ids, values, durations), keep message human-readable and stable.",
  "For performance analysis include metadata.operation and a numeric timing field such as duration_ms.",
  "Remove all instrumentation after the bug is fixed.",
] as const;

export const TRACE_LENS_INSTRUCTIONS = [
  "TraceLens is a context-efficient log debugger for AI agents.",
  "Debugging loop: (1) state a falsifiable hypothesis about the bug, (2) call tracelens_info to get the exact ingest URL or log-file convention plus ready-to-paste snippets, (3) instrument the suspect code with log calls tagged metadata.hypothesis, (4) run the failing scenario, (5) read the evidence with search_logs/inspect_logs/analyze_performance, (6) fix or form the next hypothesis, (7) remove the instrumentation.",
  "Always call tracelens_info before instrumenting; never guess endpoints.",
  "Use exactly one of source (ingested JSONL) or path (allowed local file) with inspection tools.",
].join(" ");

function httpBaseUrl(context: TraceLensServerContext): string | null {
  if (context.transport !== "http" || !context.host || !context.port) {
    return null;
  }
  return `http://${context.host}:${context.port}`;
}

function buildInstrumentation(
  context: TraceLensServerContext,
): TraceLensInstrumentation {
  const baseUrl = httpBaseUrl(context);
  const authRequired = context.authRequired ?? false;

  if (baseUrl) {
    const authHeaderJs = authRequired
      ? `\n    authorization: "Bearer <TRACELENS_TOKEN>",`
      : "";
    const authHeaderPy = authRequired
      ? `, "authorization": "Bearer <TRACELENS_TOKEN>"`
      : "";
    return {
      mode: "http",
      howTo:
        `Add these calls to the code under debug at the points that decide your hypothesis. ` +
        `POST to ${baseUrl}/ingest/{source} where {source} is your kebab-case source name. ` +
        `They are fire-and-forget and must never break the app. Remove them after the fix is verified.`,
      snippets: [
        {
          language: "javascript",
          code: [
            `// tracelens instrumentation (hypothesis H1) — remove after debugging`,
            `fetch("${baseUrl}/ingest/my-app", {`,
            `  method: "POST",`,
            `  headers: {`,
            `    "content-type": "application/json",${authHeaderJs}`,
            `  },`,
            `  body: JSON.stringify({`,
            `    level: "debug",`,
            `    message: "applyDiscount input",`,
            `    metadata: { hypothesis: "H1", price, discount, operation: "applyDiscount", duration_ms: elapsedMs },`,
            `  }),`,
            `}).catch(() => {});`,
          ].join("\n"),
        },
        {
          language: "python",
          code: [
            `# tracelens instrumentation (hypothesis H1) — remove after debugging`,
            `import json, urllib.request`,
            `def tracelens_log(message, **metadata):`,
            `    try:`,
            `        req = urllib.request.Request(`,
            `            "${baseUrl}/ingest/my-app",`,
            `            data=json.dumps({"level": "debug", "message": message, "metadata": metadata}).encode(),`,
            `            headers={"content-type": "application/json"${authHeaderPy}},`,
            `        )`,
            `        urllib.request.urlopen(req, timeout=1)`,
            `    except Exception:`,
            `        pass`,
            ``,
            `tracelens_log("applyDiscount input", hypothesis="H1", price=price, discount=discount)`,
          ].join("\n"),
        },
        {
          language: "shell",
          code: [
            `# tracelens instrumentation (hypothesis H1) — remove after debugging`,
            `curl -s -X POST ${baseUrl}/ingest/my-app \\`,
            `  -H 'content-type: application/json' \\`,
            authRequired ? `  -H 'authorization: Bearer <TRACELENS_TOKEN>' \\` : null,
            `  -d '{"level":"debug","message":"applyDiscount input","metadata":{"hypothesis":"H1","price":100}}' || true`,
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        },
      ],
      rules: [...INSTRUMENTATION_RULES],
    };
  }

  const logFile = "<project-root>/tracelens-debug.jsonl";
  return {
    mode: "file",
    howTo:
      `This server runs in stdio mode, so instrumented application code cannot reach an HTTP ingest endpoint. ` +
      `Instead, append JSON lines to a log file under an allowed root (see fileInspection.allowedRoots), ` +
      `for example ${logFile}, then inspect it with inspect_logs/search_logs using path. ` +
      `Alternatively push logs yourself with the ingest_logs MCP tool. Remove instrumentation after the fix is verified.`,
    snippets: [
      {
        language: "javascript",
        code: [
          `// tracelens instrumentation (hypothesis H1) — remove after debugging`,
          `import { appendFileSync } from "node:fs";`,
          `appendFileSync("${logFile}", JSON.stringify({`,
          `  timestamp: new Date().toISOString(),`,
          `  level: "debug",`,
          `  message: "applyDiscount input",`,
          `  metadata: { hypothesis: "H1", price, discount },`,
          `}) + "\\n");`,
        ].join("\n"),
      },
      {
        language: "python",
        code: [
          `# tracelens instrumentation (hypothesis H1) — remove after debugging`,
          `import json, datetime`,
          `def tracelens_log(message, **metadata):`,
          `    with open("${logFile}", "a") as f:`,
          `        f.write(json.dumps({`,
          `            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),`,
          `            "level": "debug", "message": message, "metadata": metadata,`,
          `        }) + "\\n")`,
          ``,
          `tracelens_log("applyDiscount input", hypothesis="H1", price=price, discount=discount)`,
        ].join("\n"),
      },
    ],
    rules: [...INSTRUMENTATION_RULES],
  };
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
    workflow: [...DEBUGGING_PLAYBOOK],
    instrumentation: buildInstrumentation(context),
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

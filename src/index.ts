#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpServer, startIngestHttpServer } from "./http.js";
import { createTraceLensServer } from "./mcp.js";
import { LogStore } from "./store.js";

interface CliOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
  ingestHttp: boolean;
}

function ingestHttpDefault(): boolean {
  const value = process.env.TRACELENS_INGEST_HTTP?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    transport: "stdio",
    host: "127.0.0.1",
    port: 7331,
    ingestHttp: ingestHttpDefault(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--http") {
      options.transport = "http";
    } else if (arg === "--transport") {
      const value = args[++index];
      if (value !== "stdio" && value !== "http") {
        throw new Error("--transport must be stdio or http");
      }
      options.transport = value;
    } else if (arg === "--host") {
      options.host = args[++index] ?? "";
      if (!options.host) {
        throw new Error("--host requires a value");
      }
    } else if (arg === "--port") {
      options.port = Number(args[++index]);
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
        throw new Error("--port must be an integer from 1 to 65535");
      }
    } else if (arg === "--no-ingest-http") {
      options.ingestHttp = false;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: tracelens [--transport stdio|http] [--host 127.0.0.1] [--port 7331] [--no-ingest-http]",
          "",
          "In stdio mode (the default) an HTTP ingest listener with GET /health and",
          "POST /ingest/:source also starts on --host:--port. Disable it with",
          "--no-ingest-http or TRACELENS_INGEST_HTTP=0.",
          "",
          "Environment:",
          "  TRACELENS_ALLOWED_ROOTS  Comma-separated file roots (default: cwd)",
          "  TRACELENS_DATA_DIR       Ingested log storage directory",
          "  TRACELENS_TOKEN          Bearer token for HTTP endpoints",
          "  TRACELENS_INGEST_HTTP    Set to 0 to disable the stdio-mode ingest listener",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function siblingTraceLensOwnsPort(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { service?: string };
    return body.service === "tracelens";
  } catch {
    return false;
  }
}

/**
 * Starts the companion ingest listener for stdio mode. Multiple stdio
 * processes (one per open project) race for the same port; the loser keeps
 * running with stdio MCP intact because the log store is shared on disk.
 * Returns whether an ingest endpoint is reachable at host:port.
 */
async function startCompanionIngest(
  options: CliOptions,
  store: LogStore,
): Promise<boolean> {
  try {
    const server = await startIngestHttpServer({
      host: options.host,
      port: options.port,
      store,
    });
    // Never keep the process alive after the stdio session ends.
    server.unref();
    process.stderr.write(
      `TraceLens HTTP ingest listening at http://${options.host}:${options.port}/ingest/{source}\n`,
    );
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      if (await siblingTraceLensOwnsPort(options.host, options.port)) {
        process.stderr.write(
          `TraceLens HTTP ingest port ${options.port} is already served by another TraceLens process; ` +
            "reusing its endpoint (the log store is shared on disk).\n",
        );
        return true;
      }
      process.stderr.write(
        `TraceLens HTTP ingest disabled: port ${options.port} is in use by another process. ` +
          "Stdio MCP keeps working; pass --port to pick a free port or --no-ingest-http to silence this.\n",
      );
      return false;
    }
    process.stderr.write(
      `TraceLens HTTP ingest disabled (${String(error)}). Stdio MCP keeps working.\n`,
    );
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.transport === "http") {
    const server = await startHttpServer(options);
    process.stderr.write(
      `TraceLens listening at http://${options.host}:${options.port}/mcp\n`,
    );
    const shutdown = () => {
      server.close(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  const store = new LogStore();
  const ingestHttp = options.ingestHttp
    ? await startCompanionIngest(options, store)
    : false;
  const server = createTraceLensServer(store, {
    transport: "stdio",
    host: options.host,
    port: options.port,
    authRequired: Boolean(process.env.TRACELENS_TOKEN),
    ingestHttp,
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`TraceLens failed: ${String(error)}\n`);
  process.exit(1);
});

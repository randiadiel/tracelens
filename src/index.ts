#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startHttpServer } from "./http.js";
import { createTraceLensServer } from "./mcp.js";

interface CliOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    transport: "stdio",
    host: "127.0.0.1",
    port: 7331,
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
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: tracelens [--transport stdio|http] [--host 127.0.0.1] [--port 7331]",
          "",
          "Environment:",
          "  TRACELENS_ALLOWED_ROOTS  Comma-separated file roots (default: cwd)",
          "  TRACELENS_DATA_DIR       Ingested log storage directory",
          "  TRACELENS_TOKEN          Bearer token for HTTP mode",
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

  const server = createTraceLensServer(undefined, { transport: "stdio" });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`TraceLens failed: ${String(error)}\n`);
  process.exit(1);
});

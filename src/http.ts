import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { createTraceLensServer } from "./mcp.js";
import { LogStore } from "./store.js";
import type { LogInput } from "./types.js";

const httpLogSchema = z.object({
  message: z.string().min(1).max(100_000),
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const ingestionSchema = z.union([
  httpLogSchema,
  z.array(httpLogSchema).min(1).max(1_000),
  z.object({ logs: z.array(httpLogSchema).min(1).max(1_000) }),
]);

export interface HttpServerOptions {
  host?: string;
  port?: number;
  token?: string;
  store?: LogStore;
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided?.startsWith("Bearer ")) {
    return false;
  }
  const actual = Buffer.from(provided.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function startHttpServer(
  options: HttpServerOptions = {},
): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7331;
  const token = options.token ?? process.env.TRACELENS_TOKEN;
  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!isLoopback && !token) {
    throw new Error(
      "TRACELENS_TOKEN is required when binding outside the loopback interface.",
    );
  }

  const store = options.store ?? new LogStore();
  const app = createMcpExpressApp({ host });
  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    if (!token || tokenMatches(req.header("authorization"), token)) {
      next();
      return;
    }
    res.status(401).json({ error: "Unauthorized" });
  };

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "tracelens" });
  });

  app.post("/ingest/:source", authenticate, async (req, res) => {
    try {
      const source = Array.isArray(req.params.source)
        ? req.params.source[0]
        : req.params.source;
      if (!source) {
        throw new Error("A source name is required.");
      }
      const parsed = ingestionSchema.parse(req.body);
      const logs: LogInput[] = Array.isArray(parsed)
        ? parsed
        : "logs" in parsed
          ? parsed.logs
          : [parsed];
      const appended = await store.append(source, logs);
      res.status(202).json({ source, appended });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
    }
  });

  app.post("/mcp", authenticate, async (req, res) => {
    const mcp = createTraceLensServer(store);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      process.stderr.write(`TraceLens MCP request failed: ${String(error)}\n`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      await transport.close();
      await mcp.close();
    }
  });

  app.all("/mcp", authenticate, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
  });

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, host, () => resolve(httpServer));
    httpServer.once("error", reject);
  });
}

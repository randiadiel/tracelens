import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startIngestHttpServer } from "../src/http.js";
import { buildTraceLensInfo } from "../src/info.js";
import { LogStore } from "../src/store.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tracelens-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function startTestServer(store: LogStore, options: { token?: string; port?: number } = {}) {
  const server = await startIngestHttpServer({
    host: "127.0.0.1",
    port: options.port ?? 0,
    token: options.token,
    store,
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, port };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("startIngestHttpServer", () => {
  it("serves the health check", async () => {
    const store = new LogStore(await tempDirectory());
    const { baseUrl } = await startTestServer(store);

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "tracelens" });
  });

  it("ingests a single log that MCP tools can read from the same store", async () => {
    const store = new LogStore(await tempDirectory());
    const { baseUrl } = await startTestServer(store);

    const response = await fetch(`${baseUrl}/ingest/my-app`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        level: "debug",
        message: "applyDiscount input",
        metadata: { hypothesis: "H1", price: 100 },
      }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ source: "my-app", appended: 1 });

    const read = await store.read("my-app", 100);
    expect(read.lines).toHaveLength(1);
    expect(read.lines[0]?.text).toContain("applyDiscount input");
  });

  it("ingests batches and rejects invalid payloads", async () => {
    const store = new LogStore(await tempDirectory());
    const { baseUrl } = await startTestServer(store);

    const batch = await fetch(`${baseUrl}/ingest/my-app`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs: [{ message: "first" }, { message: "second" }] }),
    });
    expect(batch.status).toBe(202);
    expect(await batch.json()).toEqual({ source: "my-app", appended: 2 });

    const invalid = await fetch(`${baseUrl}/ingest/my-app`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    expect(invalid.status).toBe(400);
  });

  it("shares writes with another store instance on the same directory (cross-process)", async () => {
    const directory = await tempDirectory();
    const writerStore = new LogStore(directory);
    const { baseUrl } = await startTestServer(writerStore);

    await fetch(`${baseUrl}/ingest/shared-app`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "written via HTTP" }),
    });

    // Simulates the losing stdio process: no listener, same on-disk store.
    const readerStore = new LogStore(directory);
    expect(await readerStore.list()).toMatchObject([{ name: "shared-app" }]);
    const read = await readerStore.read("shared-app", 100);
    expect(read.lines[0]?.text).toContain("written via HTTP");
  });

  it("enforces the bearer token on ingest but not on health", async () => {
    const store = new LogStore(await tempDirectory());
    const { baseUrl } = await startTestServer(store, { token: "secret" });

    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);

    const unauthorized = await fetch(`${baseUrl}/ingest/my-app`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "nope" }),
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/ingest/my-app`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({ message: "yes" }),
    });
    expect(authorized.status).toBe(202);
  });

  it("answers CORS preflight with permissive headers and without auth", async () => {
    const store = new LogStore(await tempDirectory());
    const { baseUrl } = await startTestServer(store, { token: "secret" });

    const preflight = await fetch(`${baseUrl}/ingest/my-app`, {
      method: "OPTIONS",
      headers: {
        origin: "http://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type",
    );
  });

  it("sets CORS headers on actual responses", async () => {
    const store = new LogStore(await tempDirectory());
    const { baseUrl } = await startTestServer(store);

    const response = await fetch(`${baseUrl}/ingest/my-app`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://example.com" },
      body: JSON.stringify({ message: "from a browser" }),
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("ingests JSON bodies sent with preflight-free content types", async () => {
    const store = new LogStore(await tempDirectory());
    const { baseUrl } = await startTestServer(store);
    const payload = JSON.stringify({ message: "simple request" });

    for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
      const response = await fetch(`${baseUrl}/ingest/my-app`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: payload,
      });
      expect(response.status, contentType).toBe(202);
    }

    // A byte body keeps fetch from adding a content-type header.
    const noContentType = await fetch(`${baseUrl}/ingest/my-app`, {
      method: "POST",
      body: new TextEncoder().encode(payload),
    });
    expect(noContentType.status).toBe(202);

    const read = await store.read("my-app", 100);
    expect(read.lines).toHaveLength(3);
  });

  it("rejects non-JSON text bodies with a clear error", async () => {
    const store = new LogStore(await tempDirectory());
    const { baseUrl } = await startTestServer(store);

    const response = await fetch(`${baseUrl}/ingest/my-app`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "message=not-json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Request body must be valid JSON (any content-type is accepted).",
    });
  });

  it("does not mount the /mcp route", async () => {
    const store = new LogStore(await tempDirectory());
    const { baseUrl } = await startTestServer(store);

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(response.status).toBe(404);
  });

  it("rejects with EADDRINUSE when the port is already taken", async () => {
    const store = new LogStore(await tempDirectory());
    const { port } = await startTestServer(store);

    await expect(
      startIngestHttpServer({ host: "127.0.0.1", port, store }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("requires a token when binding outside the loopback interface", async () => {
    const store = new LogStore(await tempDirectory());
    await expect(
      startIngestHttpServer({ host: "0.0.0.0", port: 0, store }),
    ).rejects.toThrow("TRACELENS_TOKEN is required");
  });
});

describe("buildTraceLensInfo in stdio combo mode", () => {
  it("advertises the HTTP ingest endpoint but no /mcp endpoint", async () => {
    const store = new LogStore(await tempDirectory());

    const info = await buildTraceLensInfo(store, {
      transport: "stdio",
      host: "127.0.0.1",
      port: 7331,
      ingestHttp: true,
    });

    expect(info.transport).toBe("stdio");
    expect(info.endpoints.mcp).toBeNull();
    expect(info.endpoints.health).toBe("http://127.0.0.1:7331/health");
    expect(info.ingest.httpUrlTemplate).toBe("http://127.0.0.1:7331/ingest/{source}");
    expect(info.instrumentation.mode).toBe("http");
    const javascript = info.instrumentation.snippets.find(
      (snippet) => snippet.language === "javascript",
    );
    expect(javascript?.code).toContain("fetch(\"http://127.0.0.1:7331/ingest/");
  });

  it("falls back to file instrumentation when the ingest listener is unavailable", async () => {
    const store = new LogStore(await tempDirectory());

    const info = await buildTraceLensInfo(store, {
      transport: "stdio",
      host: "127.0.0.1",
      port: 7331,
      ingestHttp: false,
    });

    expect(info.endpoints.health).toBeNull();
    expect(info.ingest.httpUrlTemplate).toBeNull();
    expect(info.instrumentation.mode).toBe("file");
  });
});

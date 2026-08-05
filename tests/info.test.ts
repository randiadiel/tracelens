import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTraceLensInfo } from "../src/info.js";
import { LogStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tracelens-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("buildTraceLensInfo", () => {
  it("returns HTTP ingest endpoints and auth guidance", async () => {
    const directory = await tempDirectory();
    const store = new LogStore(directory);
    await store.append("api", [{ message: "booted" }]);

    const info = await buildTraceLensInfo(store, {
      transport: "http",
      host: "127.0.0.1",
      port: 7331,
      authRequired: true,
    });

    expect(info.transport).toBe("http");
    expect(info.endpoints.mcp).toBe("http://127.0.0.1:7331/mcp");
    expect(info.endpoints.health).toBe("http://127.0.0.1:7331/health");
    expect(info.ingest.httpUrlTemplate).toBe("http://127.0.0.1:7331/ingest/{source}");
    expect(info.ingest.authHeader).toContain("Bearer");
    expect(info.ingest.httpExample).toContain("/ingest/my-api");
    expect(info.storage.dataDir).toBe(directory);
    expect(info.storage.sources).toHaveLength(1);
    expect(info.tools.some((tool) => tool.name === "tracelens_info")).toBe(true);
    expect(info.workflow.length).toBeGreaterThan(0);
    expect(info.workflow[0]).toContain("HYPOTHESIZE");
    expect(info.instrumentation.mode).toBe("http");
    const javascript = info.instrumentation.snippets.find(
      (snippet) => snippet.language === "javascript",
    );
    expect(javascript?.code).toContain("fetch(\"http://127.0.0.1:7331/ingest/");
    expect(javascript?.code).toContain("hypothesis");
    expect(javascript?.code).toContain("Bearer <TRACELENS_TOKEN>");
    expect(info.instrumentation.rules.length).toBeGreaterThan(0);
  });

  it("omits the auth header from snippets when no token is required", async () => {
    const directory = await tempDirectory();
    const store = new LogStore(directory);

    const info = await buildTraceLensInfo(store, {
      transport: "http",
      host: "127.0.0.1",
      port: 7331,
      authRequired: false,
    });

    for (const snippet of info.instrumentation.snippets) {
      expect(snippet.code).not.toContain("TRACELENS_TOKEN");
    }
  });

  it("returns MCP-only ingest guidance in stdio mode", async () => {
    const directory = await tempDirectory();
    const store = new LogStore(directory);

    const info = await buildTraceLensInfo(store, { transport: "stdio" });

    expect(info.transport).toBe("stdio");
    expect(info.endpoints.mcp).toBeNull();
    expect(info.endpoints.health).toBeNull();
    expect(info.ingest.httpUrlTemplate).toBeNull();
    expect(info.ingest.httpExample).toBeNull();
    expect(info.ingest.mcpTool).toBe("ingest_logs");
    expect(info.instrumentation.mode).toBe("file");
    expect(info.instrumentation.howTo).toContain("stdio");
    expect(
      info.instrumentation.snippets.every((snippet) =>
        snippet.code.includes("tracelens-debug.jsonl"),
      ),
    ).toBe(true);
  });
});

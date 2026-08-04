import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTail } from "../src/read.js";
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

describe("LogStore", () => {
  it("appends and reads structured logs", async () => {
    const directory = await tempDirectory();
    const store = new LogStore(directory);

    await store.append("api", [
      {
        timestamp: "2026-08-04T06:00:00.000Z",
        level: "error",
        message: "request failed",
        metadata: { route: "/users" },
      },
    ]);

    const result = await store.read("api", 100);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.text).toContain("ERROR request failed");
    expect(await store.list()).toMatchObject([{ name: "api" }]);
  });

  it("rejects unsafe source names", async () => {
    const store = new LogStore(await tempDirectory());
    await expect(
      store.append("../outside", [{ message: "no" }]),
    ).rejects.toThrow("Source must");
  });
});

describe("readTail", () => {
  it("only reads files under an allowed root", async () => {
    const allowed = await tempDirectory();
    const outside = await tempDirectory();
    const allowedFile = path.join(allowed, "app.txt");
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(allowedFile, "one\ntwo\nthree\n");
    await writeFile(outsideFile, "secret\n");

    const result = await readTail(allowedFile, 2, { roots: [allowed] });
    expect(result.lines.map((line) => line.text)).toEqual(["two", "three"]);
    await expect(readTail(outsideFile, 10, { roots: [allowed] })).rejects.toThrow(
      "outside TRACE_LENS_ALLOWED_ROOTS",
    );
  });
});

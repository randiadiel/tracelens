import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countHypotheses,
  extractHypothesis,
  filterByHypothesis,
} from "../src/hypothesis.js";
import { LogStore } from "../src/store.js";
import type { NumberedLine } from "../src/types.js";

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

function numbered(texts: string[]): NumberedLine[] {
  return texts.map((text, index) => ({ number: index + 1, text }));
}

describe("extractHypothesis", () => {
  it("reads the hypothesis tag from raw JSONL lines", () => {
    expect(
      extractHypothesis('{"message":"x","metadata":{"hypothesis":"H1","price":10}}'),
    ).toBe("H1");
  });

  it("reads the hypothesis tag from formatted store lines", () => {
    expect(
      extractHypothesis('2026-08-05T01:00:00.000Z DEBUG applyDiscount {"hypothesis":"H2"}'),
    ).toBe("H2");
  });

  it("does not match the bare word outside a metadata tag", () => {
    expect(extractHypothesis("testing hypothesis H1 in plain text")).toBeNull();
  });
});

describe("countHypotheses and filterByHypothesis", () => {
  const lines = numbered([
    'a INFO start {"hypothesis":"H1"}',
    "b INFO untagged application log",
    'c INFO check {"hypothesis":"H2"}',
    'd INFO end {"hypothesis":"H1"}',
  ]);

  it("counts lines per hypothesis group", () => {
    expect(countHypotheses(lines)).toEqual({ H1: 2, H2: 1 });
  });

  it("returns only the requested group", () => {
    const filtered = filterByHypothesis(lines, "H1");
    expect(filtered).toHaveLength(2);
    expect(filtered.map((line) => line.number)).toEqual([1, 4]);
  });

  it("returns nothing for an unknown group", () => {
    expect(filterByHypothesis(lines, "H9")).toHaveLength(0);
  });
});

describe("hypothesis filtering over stored logs", () => {
  it("groups logs ingested with metadata.hypothesis", async () => {
    const directory = await tempDirectory();
    const store = new LogStore(directory);
    await store.append("api", [
      { message: "before fix", metadata: { hypothesis: "H1", total: 90 } },
      { message: "unrelated app log" },
      { message: "after fix", metadata: { hypothesis: "H2", total: 100 } },
    ]);

    const read = await store.read("api", 100);
    expect(countHypotheses(read.lines)).toEqual({ H1: 1, H2: 1 });
    const h2 = filterByHypothesis(read.lines, "H2");
    expect(h2).toHaveLength(1);
    expect(h2[0]?.text).toContain("after fix");
  });
});

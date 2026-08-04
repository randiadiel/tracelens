import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTail } from "./read.js";
import type { LogInput, ReadResult } from "./types.js";

const SOURCE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

interface StoredLog {
  timestamp: string;
  level: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface SourceInfo {
  name: string;
  bytes: number;
  updatedAt: string;
}

export class LogStore {
  readonly directory: string;

  constructor(directory = process.env.TRACELENS_DATA_DIR ?? path.join(os.homedir(), ".tracelens", "logs")) {
    this.directory = path.resolve(directory);
  }

  validateSource(source: string): string {
    if (!SOURCE_NAME.test(source) || source === "." || source === "..") {
      throw new Error(
        "Source must be 1-80 characters and contain only letters, numbers, dots, dashes, or underscores.",
      );
    }
    return source;
  }

  private filePath(source: string): string {
    return path.join(this.directory, `${this.validateSource(source)}.jsonl`);
  }

  async append(source: string, logs: LogInput[]): Promise<number> {
    this.validateSource(source);
    if (logs.length === 0) {
      return 0;
    }
    await mkdir(this.directory, { recursive: true });

    const now = new Date().toISOString();
    const payload = logs
      .map((log): StoredLog => ({
        timestamp: log.timestamp ?? now,
        level: log.level ?? "info",
        message: log.message,
        ...(log.metadata ? { metadata: log.metadata } : {}),
      }))
      .map((log) => `${JSON.stringify(log)}\n`)
      .join("");

    await appendFile(this.filePath(source), payload, "utf8");
    return logs.length;
  }

  async read(source: string, maxLines: number): Promise<ReadResult> {
    const result = await readTail(this.filePath(source), maxLines, { trusted: true });
    return {
      ...result,
      source,
      lines: result.lines.map((line) => ({
        ...line,
        text: formatStoredLine(line.text),
      })),
    };
  }

  async list(): Promise<SourceInfo[]> {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const sources = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry): Promise<SourceInfo> => {
          const info = await stat(path.join(this.directory, entry.name));
          return {
            name: entry.name.slice(0, -".jsonl".length),
            bytes: info.size,
            updatedAt: info.mtime.toISOString(),
          };
        }),
    );
    return sources.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

function formatStoredLine(raw: string): string {
  try {
    const value = JSON.parse(raw) as StoredLog;
    const metadata = value.metadata ? ` ${JSON.stringify(value.metadata)}` : "";
    return `${value.timestamp} ${value.level.toUpperCase()} ${value.message}${metadata}`;
  } catch {
    return raw;
  }
}

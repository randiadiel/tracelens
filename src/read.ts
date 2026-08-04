import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { NumberedLine, ReadResult } from "./types.js";

const MAX_READ_BYTES = 5 * 1024 * 1024;

export function configuredRoots(): string[] {
  const configured = process.env.TRACELENS_ALLOWED_ROOTS;
  return (configured ? configured.split(",") : [process.cwd()])
    .map((root) => path.resolve(root.trim()))
    .filter(Boolean);
}

async function assertAllowedPath(filePath: string, roots: string[]): Promise<string> {
  const resolvedFile = await realpath(path.resolve(filePath));
  const info = await stat(resolvedFile);
  if (!info.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  for (const root of roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(root);
    } catch {
      continue;
    }
    const relative = path.relative(resolvedRoot, resolvedFile);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return resolvedFile;
    }
  }

  throw new Error(
    `Path is outside TRACE_LENS_ALLOWED_ROOTS: ${roots.join(", ")}`,
  );
}

export async function readTail(
  filePath: string,
  maxLines: number,
  options: { roots?: string[]; trusted?: boolean } = {},
): Promise<ReadResult> {
  const resolvedFile = options.trusted
    ? path.resolve(filePath)
    : await assertAllowedPath(filePath, options.roots ?? configuredRoots());
  const file = await open(resolvedFile, "r");

  try {
    const info = await file.stat();
    const bytesRead = Math.min(info.size, MAX_READ_BYTES);
    const start = Math.max(0, info.size - bytesRead);
    const buffer = Buffer.alloc(bytesRead);
    if (bytesRead > 0) {
      await file.read(buffer, 0, bytesRead, start);
    }

    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }

    const allLines = text.split(/\r?\n/);
    if (allLines.at(-1) === "") {
      allLines.pop();
    }
    const selected = allLines.slice(-maxLines);
    const firstWindowLine = Math.max(1, allLines.length - selected.length + 1);
    const lines: NumberedLine[] = selected.map((line, index) => ({
      number: firstWindowLine + index,
      text: line,
    }));

    return {
      lines,
      totalBytes: info.size,
      bytesRead,
      truncatedAtStart: start > 0 || selected.length < allLines.length,
      source: resolvedFile,
    };
  } finally {
    await file.close();
  }
}

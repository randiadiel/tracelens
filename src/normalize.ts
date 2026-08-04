const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ISO_TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const PREFIX_TIME = /(^|[\s[])\d{1,2}:[0-5]\d:[0-5]\d(?:\.\d+)?(?=\s|])/g;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const DYNAMIC_KEY_VALUE =
  /\b(attempt|count|iteration|pid|request_?id|retry|seq(?:uence)?|span_?id|tick|trace_?id)=["']?[a-z0-9_.:-]+["']?/gi;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

/**
 * Removes common values that change on every iteration without hiding ordinary
 * error codes, ports, or business values.
 */
export function normalizeLine(value: string): string {
  return stripAnsi(value)
    .replace(ISO_TIMESTAMP, "<timestamp>")
    .replace(PREFIX_TIME, "$1<time>")
    .replace(UUID, "<uuid>")
    .replace(DYNAMIC_KEY_VALUE, (_match, key: string) => `${key.toLowerCase()}=<value>`)
    .replace(/\s+/g, " ")
    .trim();
}

export function clampLine(value: string, maxLength: number): string {
  const clean = stripAnsi(value);
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, maxLength - 24))} … [line truncated]`;
}

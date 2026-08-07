# TraceLens

TraceLens is a local MCP server for AI-assisted log debugging. It can inspect
allowed log files or accept logs over HTTP, then returns a bounded, compressed
view instead of flooding the model context.

It detects:

- consecutive lines that only differ by timestamps, request IDs, or loop counters
- repeating multi-line cycles near the end of a log
- repeated bursts elsewhere in the inspected window
- oversized output, which is truncated from the oldest entries first

## Install

Requires Node.js 20 or newer.

```bash
npm install
npm run build
```

Once published, run it without installing:

```bash
npx -y @randiadiel/tracelens@latest
```

## Run as a local stdio MCP server

Add this server to any MCP client:

```json
{
  "mcpServers": {
    "tracelens": {
      "command": "npx",
      "args": ["-y", "@randiadiel/tracelens@latest"],
      "env": {
        "TRACELENS_ALLOWED_ROOTS": "/path/to/project,/var/log/my-app"
      }
    }
  }
}
```

`TRACELENS_ALLOWED_ROOTS` defaults to the process working directory. File reads
outside these roots, including symlink escapes, are rejected.

### HTTP ingest in stdio mode

The stdio server also opens an HTTP ingest listener on `127.0.0.1:7331` with
`GET /health` and `POST /ingest/:source` (no `/mcp` route), so instrumented
application code can push logs while the MCP client talks over stdio. One
process, one command, both interfaces live. Disable it with `--no-ingest-http`
or `TRACELENS_INGEST_HTTP=0`; change the address with `--host`/`--port`.

When several stdio processes run at once (for example one per open project),
they race for the port. The winner serves ingest for everyone; losers log an
info line to stderr and keep working, because the log store is shared on disk.
If a losing process confirms the port is held by another TraceLens (via
`GET /health`), its `tracelens_info` still advertises the shared ingest URL.

## Run as a shared local HTTP MCP server

HTTP mode lets multiple agents use the same MCP endpoint and lets applications
push logs to TraceLens:

```bash
npm start -- --http
```

The MCP endpoint is `http://127.0.0.1:7331/mcp`. Configure that URL as a
Streamable HTTP MCP server in your client.

Push one log:

```bash
curl -X POST http://127.0.0.1:7331/ingest/my-api \
  -H 'content-type: application/json' \
  -d '{"level":"error","message":"database connection failed","metadata":{"attempt":3}}'
```

Push a batch with either a JSON array or `{"logs": [...]}`. Ingested logs are
stored as JSONL under `~/.tracelens/logs` by default.

CORS is wide open (`Access-Control-Allow-Origin: *`), so browser apps can post
logs directly with `fetch`. The body is parsed as JSON regardless of the
`Content-Type` header — send `text/plain` (or none at all) to skip the CORS
preflight entirely.

To listen beyond localhost, a bearer token is mandatory:

```bash
TRACELENS_TOKEN='replace-me' npm start -- --http --host 0.0.0.0
```

Send `Authorization: Bearer replace-me` to both `/mcp` and `/ingest/:source`.

## How agents debug with TraceLens

The server teaches agents a hypothesis-driven loop. The MCP server
instructions summarize it, and `tracelens_info` returns the full playbook plus
ready-to-paste instrumentation snippets containing the live ingest URL:

1. State one falsifiable hypothesis about the bug (`H1: ...`).
2. Call `tracelens_info` for the exact ingest URL (HTTP mode) or the
   JSONL-file convention (stdio mode). Never guess endpoints.
3. Instrument the suspect code with the returned `fetch`/logging snippet,
   tagging every log with `metadata.hypothesis` so evidence is searchable and
   cleanup is greppable.
4. Reproduce the failure so the instrumented code runs.
5. Read the evidence with `search_logs`, `inspect_logs`, or
   `analyze_performance`, passing `hypothesis: "H1"` so only that group's
   logs enter the model context. Responses include `hypothesesInWindow`
   (group → line count) so available groups are discoverable.
6. Fix and re-verify, or form `H2` and repeat.
7. Remove the instrumentation.

When no HTTP ingest endpoint is available (stdio mode with the listener
disabled or its port taken by a non-TraceLens process), the snippets instead
append JSON lines to a file under an allowed root, inspected via `path`.

## MCP tools

- `tracelens_info` — returns the debugging playbook, instrumentation snippets
  with the live ingest URL, storage paths, available sources, and a tool
  guide. Call before instrumenting any code.
- `list_log_sources` — lists logs pushed into the local store.
- `ingest_logs` — appends structured logs through MCP.
- `inspect_logs` — tails a source or file, compresses repeats, detects loops,
  and applies a character budget.
- `search_logs` — searches recent logs and returns compressed context around
  the newest matches.
- `analyze_performance` — extracts timing and resource metrics, groups similar
  operations, and ranks p95 latency, total-time bottlenecks, and slow outliers.

Use exactly one of `source` or `path` with inspection tools.

## Context efficiency

`inspect_logs` reads at most the latest 5 MiB and defaults to 5,000 lines. It
normalizes volatile timestamps, UUIDs, and named counters before comparing
lines, while keeping the first original line as the sample. A repeated cycle is
returned once with its pattern, occurrence count, and covered line range.

The analyzed log payload defaults to a 12,000-character budget with a
tool-configured 30,000-character ceiling. Small read metadata is added outside
that budget. If unique logs still exceed the budget, TraceLens keeps the newest
context and reports how many lines were omitted.

Loop detection is evidence, not proof that a process is stuck. The response
labels confidence and includes the repeated pattern so the agent can decide.

## Performance debugging

`analyze_performance` recognizes common timing fields such as `duration`,
`duration_ms`, `elapsed`, `latency`, and messages like `completed in 120ms`.
It also recognizes `cpu_percent`, `memory_mb`, `rss`, `heap_used`, and
`event_loop_lag`.

Include an operation, route, endpoint, span, task, or job name so samples group
cleanly:

```json
{
  "message": "request completed",
  "metadata": {
    "operation": "GET /api/users/:id",
    "duration_ms": 842,
    "cpu_percent": 74,
    "memory_mb": 512
  }
}
```

The result distinguishes the highest tail latency from the operation consuming
the most total observed time. It does not claim causation from correlation; the
returned slow lines and resource peaks give the agent evidence for follow-up.

## Configuration

| Variable | Purpose |
| --- | --- |
| `TRACELENS_ALLOWED_ROOTS` | Comma-separated roots available to file inspection |
| `TRACELENS_DATA_DIR` | Directory for ingested JSONL logs |
| `TRACELENS_TOKEN` | Optional localhost HTTP token; required off-loopback |
| `TRACELENS_INGEST_HTTP` | Set to `0` to disable the stdio-mode HTTP ingest listener |

## Publishing

The `publish.yml` GitHub Actions workflow runs after every merge to `main`. It
tests and builds the package, then publishes only when the version in
`package.json` does not already exist on npm.

Before the first merge:

1. Ensure the `randiadiel` npm account or organization owns the
   `@randiadiel` scope.
2. Create an npm granular access token that can publish packages in that scope.
3. Add it as the `NPM_TOKEN` Actions secret in the GitHub repository.

Each release must change the version:

```bash
npm version patch --no-git-tag-version
```

After the initial publish, configure npm trusted publishing for GitHub user
`randiadiel`, repository `tracelens`, workflow `publish.yml`, with
`npm publish` allowed. The workflow already has OIDC permission, so the
long-lived `NPM_TOKEN` secret can then be removed.

```bash
npm test
npm run build
```
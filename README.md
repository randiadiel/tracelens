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

## Run as a local stdio MCP server

Add this server to any MCP client:

```json
{
  "mcpServers": {
    "tracelens": {
      "command": "node",
      "args": ["/absolute/path/to/tracelens/dist/index.js"],
      "env": {
        "TRACELENS_ALLOWED_ROOTS": "/path/to/project,/var/log/my-app"
      }
    }
  }
}
```

`TRACELENS_ALLOWED_ROOTS` defaults to the process working directory. File reads
outside these roots, including symlink escapes, are rejected.

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

To listen beyond localhost, a bearer token is mandatory:

```bash
TRACELENS_TOKEN='replace-me' npm start -- --http --host 0.0.0.0
```

Send `Authorization: Bearer replace-me` to both `/mcp` and `/ingest/:source`.

## MCP tools

- `list_log_sources` — lists logs pushed into the local store.
- `ingest_logs` — appends structured logs through MCP.
- `inspect_logs` — tails a source or file, compresses repeats, detects loops,
  and applies a character budget.
- `search_logs` — searches recent logs and returns compressed context around
  the newest matches.

Use exactly one of `source` or `path` with inspection tools.

## Context efficiency

`inspect_logs` reads at most the latest 5 MiB and defaults to 5,000 lines. It
normalizes volatile timestamps, UUIDs, and named counters before comparing
lines, while keeping the first original line as the sample. A repeated cycle is
returned once with its pattern, occurrence count, and covered line range.

Responses default to a 12,000-character budget and never exceed the
tool-configured 30,000-character ceiling. If unique logs still exceed the
budget, TraceLens keeps the newest context and reports how many lines were
omitted.

Loop detection is evidence, not proof that a process is stuck. The response
labels confidence and includes the repeated pattern so the agent can decide.

## Configuration

| Variable | Purpose |
| --- | --- |
| `TRACELENS_ALLOWED_ROOTS` | Comma-separated roots available to file inspection |
| `TRACELENS_DATA_DIR` | Directory for ingested JSONL logs |
| `TRACELENS_TOKEN` | Optional localhost HTTP token; required off-loopback |

```bash
npm test
npm run build
```
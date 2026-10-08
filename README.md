# InvoicePDFs MCP server

Gives an AI agent the InvoicePDFs API as tools: render a document, check it for
e-invoicing compliance, manage customers, and reach the rest of the API on
demand.

It is an ordinary HTTPS client of the public API. No database, no extra service
to deploy, nothing added to `render.yaml`. It runs on your machine.

## Use it

Add to your MCP client's configuration — Claude Desktop, Cursor, or anything
else that speaks MCP over stdio:

```json
{
  "mcpServers": {
    "invoicepdfs": {
      "command": "npx",
      "args": ["-y", "@invoicepdfs/mcp"],
      "env": { "INVOICEPDFS_API_KEY": "inv_live_..." }
    }
  }
}
```

Create a key at <https://invoicepdfs.com>. `INVOICEPDFS_BASE_URL` overrides the
host if you are pointing at a local server.

**An API key is not scoped.** Any key you give this server can do anything your
account can, including deleting data. That is a property of the key, not of this
server — there is no narrower credential to hand it. Your MCP client will still
ask before each tool call.

## What it offers

Thirty tools. Twenty-seven name a common operation outright —
`document_render`, `document_create`, `compliance_check`, `customer_list` and so
on — `document_transition` covers the seven-state document lifecycle through one
`to` argument, and two reach everything else:

- **`find_operation`** — search all 161 operations by what they do and get the
  full input schema of each match.
- **`call_operation`** — run one of them.

The whole API is reachable; only the common path is listed up front. Every
client caps the tool list (Cursor around 40, Junie 100, Copilot 128), so a
server advertising 161 tools would either break or crowd out every other server
you have connected.

`document_render` renders asynchronously and waits for the result, so it returns
a finished render rather than a queued one. Rendering is CPU-bound and served by
a single worker, so prefer one render at a time over starting many in parallel.

## How it is built

**The tool surface is built from `openapi.json` at startup.** `src/operations.ts`
reads the spec and derives each operation's name, input schema and description;
`src/client.ts` is one executor that can run any of them. Adding an endpoint to
the API adds a working tool with no code change here.

It is built at runtime rather than generated into a committed file on purpose.
The first version of this emitted 16,000 lines of TypeScript that had to be
regenerated and committed whenever the API changed — a second copy of the spec,
with its own way of going stale. Parsing the spec costs about 10ms, once, in a
process that starts once.

Only three things are written by hand:

| File | Why it cannot come from the spec |
|---|---|
| `src/manifest.ts` | Which operations are promoted, and what they are called |
| `src/tools/documentRender.ts` | Async default and poll-until-terminal |
| `src/tools/findOperation.ts` | The search, and the lazy load |

Tool descriptions come from the API's handler docstrings, through the spec. They
are not written here, because prose about an operation kept in two places drifts.

## Develop

```bash
npm install
npm test        # drift and tool-surface checks
npm run build   # compiles
npm pack        # vendors openapi.json into the tarball, then cleans up
```

**This repository is generated.** The source lives in the InvoicePDFs API
monorepo under `mcp/`, and every commit here is a sync from there — so a change
made in this repository is overwritten by the next one. Open an issue instead
and it gets made where it survives.

The reason for the split is that the two things want different homes. The code
belongs next to the API it describes: tool descriptions are the API handlers'
own docstrings, and `npm test` fails when the manifest names an operation the
spec no longer has, which is a guard that only works if it runs in the pull
request that renames the handler. The *package* belongs in a public repository,
because npm build provenance requires one, and because a registry listing with
no readable source behind it is worth less.

So the drift guard runs upstream on every API change, and this repository
publishes.

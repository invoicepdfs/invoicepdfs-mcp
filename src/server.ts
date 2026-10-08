#!/usr/bin/env node
/**
 * The InvoicePDFs MCP server.
 *
 * A stdio server that is an ordinary HTTPS client of the API: no database, no
 * new service, nothing added to render.yaml. It runs on the user's machine
 * under `npx`.
 *
 * The tool surface is the promoted set from `manifest.ts` plus `find_operation`
 * and `call_operation`, which reach the remaining operations on demand.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { InvoicePdfsClient, describeError } from "./client.js";
import { BY_ID } from "./operations.js";
import { PROMOTED } from "./manifest.js";
import {
  CALL_OPERATION_SCHEMA,
  FIND_OPERATION_SCHEMA,
  findOperation,
} from "./tools/findOperation.js";
import {
  DOCUMENT_RENDER_DESCRIPTION,
  documentRender,
  documentRenderSchema,
} from "./tools/documentRender.js";
import {
  documentTransition,
  documentTransitionDescription,
  documentTransitionSchema,
} from "./tools/documentTransition.js";

const RENDER_TOOL = "document_render";
const TRANSITION_TOOL = "document_transition";

function buildTools(): Tool[] {
  const tools: Tool[] = PROMOTED.map(({ name, operationId }) => {
    const op = BY_ID[operationId];
    if (!op) {
      // The drift test fails first in CI. Kept so a hand-edited manifest fails
      // loudly at startup rather than serving a tool that 404s on first use.
      throw new Error(
        `manifest names "${operationId}", which is not in openapi.json — update src/manifest.ts`,
      );
    }
    return {
      name,
      description:
        name === RENDER_TOOL ? DOCUMENT_RENDER_DESCRIPTION : op.description,
      inputSchema: (name === RENDER_TOOL
        ? documentRenderSchema()
        : op.inputSchema) as Tool["inputSchema"],
    };
  });

  tools.push(
    {
      name: TRANSITION_TOOL,
      description: documentTransitionDescription(),
      inputSchema: documentTransitionSchema() as Tool["inputSchema"],
    },
    {
      name: "find_operation",
      description:
        "Search every InvoicePDFs API operation by what it does, and get back " +
        "the full input schema of each match. Use this when no tool above " +
        "covers what you need — most of the API is reachable this way.",
      inputSchema: FIND_OPERATION_SCHEMA as Tool["inputSchema"],
    },
    {
      name: "call_operation",
      description:
        "Run any operation returned by find_operation, by name.",
      inputSchema: CALL_OPERATION_SCHEMA as Tool["inputSchema"],
    },
  );

  return tools;
}

function textResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The version we advertise over MCP, read from package.json rather than typed
 * here, so `npm version` cannot leave the server announcing the old release.
 *
 * Same relative position in both layouts: dist/server.js and src/server.ts are
 * each one level below the package root.
 */
function packageVersion(): string {
  const here: string = dirname(fileURLToPath(import.meta.url));
  const raw: string = readFileSync(join(here, "..", "package.json"), "utf8");
  const version: unknown = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string") {
    throw new Error("package.json has no version string");
  }
  return version;
}

async function main(): Promise<void> {
  const apiKey: string | undefined = process.env.INVOICEPDFS_API_KEY;
  if (!apiKey) {
    // stderr, not stdout: stdout is the protocol channel.
    console.error(
      "INVOICEPDFS_API_KEY is not set. Create a key at https://invoicepdfs.com " +
        "and set it in your MCP client's server configuration.",
    );
    process.exit(1);
  }

  const client = new InvoicePdfsClient(
    apiKey,
    process.env.INVOICEPDFS_BASE_URL || undefined,
  );
  const tools: Tool[] = buildTools();
  const byName = new Map(PROMOTED.map((t) => [t.name, t.operationId]));

  const server = new Server(
    { name: "invoicepdfs", version: packageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name: string = request.params.name;
    const args: Record<string, unknown> =
      (request.params.arguments as Record<string, unknown>) ?? {};

    try {
      if (name === RENDER_TOOL) {
        return textResult(await documentRender(client, args));
      }
      if (name === TRANSITION_TOOL) {
        return textResult(await documentTransition(client, args));
      }
      if (name === "find_operation") {
        return textResult(findOperation(String(args.query ?? "")));
      }
      if (name === "call_operation") {
        const target = BY_ID[String(args.operation)];
        if (!target) {
          return textResult(
            `No operation named "${args.operation}". Use find_operation to look one up.`,
            true,
          );
        }
        return textResult(
          await client.call(
            target,
            (args.arguments as Record<string, unknown>) ?? {},
          ),
        );
      }

      const operationId: string | undefined = byName.get(name);
      if (!operationId) return textResult(`Unknown tool "${name}".`, true);
      return textResult(await client.call(BY_ID[operationId], args));
    } catch (err) {
      // Returned as an error result rather than thrown: the model can act on a
      // 429 or a validation message, but a transport-level failure it cannot see.
      return textResult(describeError(err), true);
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

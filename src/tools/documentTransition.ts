/**
 * `document_transition` — seven lifecycle operations as one tool.
 *
 * `finalize_document`, `mark_sent`, `mark_paid`, `mark_unpaid`, `void_document`,
 * `archive_document` and `restore_document` are all the same idea: move a
 * document from one state to another. Each takes a document id and nothing
 * else.
 *
 * As seven sibling tools they are the wrong shape for a model. It has to know
 * which transition exists before it can pick one, the flat list conveys no
 * ordering, and two of them read as duplicates of things they are not:
 *
 *   - `mark_sent` sits next to `document_send` and looks like the same tool.
 *     One records that delivery happened; the other actually emails a customer.
 *   - `mark_unpaid` looks like a way to refuse a payment rather than to undo a
 *     status set in error.
 *
 * **Nothing here describes an operation.** The state names come from the
 * manifest; the parameter schema and every word about what each transition
 * does are read from the spec, so a handler docstring edited in `app/` changes
 * this tool without anyone touching it. The only prose written here is the one
 * sentence distinguishing this tool from `document_send`, which is about the
 * tool surface rather than about any operation.
 */

import type { InvoicePdfsClient } from "../client.js";
import { BY_ID, type Operation } from "../operations.js";
import { TRANSITIONS } from "../manifest.js";

/** The operations behind the tool, or a loud failure naming what moved. */
function targets(): Array<[string, Operation]> {
  return Object.entries(TRANSITIONS).map(([state, id]) => {
    const op: Operation | undefined = BY_ID[id];
    if (!op) {
      throw new Error(
        `document_transition maps "${state}" to ${id}, which is not in the spec — update TRANSITIONS in src/manifest.ts`,
      );
    }
    // Collapsing is only sound while they take the same input. If one grows a
    // body or a query parameter, one schema can no longer stand for all seven
    // and it must stop being a single tool.
    if (op.hasBody || op.queryParams.length || op.pathParams.length !== 1) {
      throw new Error(
        `${id} no longer takes just a document id (body=${op.hasBody}, query=${op.queryParams.length}, path=${op.pathParams.length}) — it cannot be collapsed into document_transition`,
      );
    }
    return [state, op];
  });
}

export async function documentTransition(
  client: InvoicePdfsClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  const to: string = String(args.to ?? "");
  const operationId: string | undefined = TRANSITIONS[to];
  if (!operationId) {
    throw new Error(
      `"${to}" is not a state a document can be moved to. Use one of: ${Object.keys(TRANSITIONS).join(", ")}.`,
    );
  }
  return client.call(BY_ID[operationId], { document_id: args.document_id });
}

/** Built from the underlying operations, never hand-written. */
export function documentTransitionSchema(): Record<string, unknown> {
  const pairs: Array<[string, Operation]> = targets();
  const [, first] = pairs[0];
  const properties = (first.inputSchema as { properties: Record<string, unknown> })
    .properties;

  return {
    type: "object",
    properties: {
      // The document id as the API itself describes it.
      document_id: properties.document_id,
      to: {
        type: "string",
        enum: pairs.map(([state]) => state),
        description:
          "The state to move the document to.\n\n" +
          pairs
            .map(([state, op]) => `- \`${state}\` — ${summarise(op)}`)
            .join("\n"),
      },
    },
    required: ["document_id", "to"],
  };
}

/** An operation's own first line, which is what the handler docstring says. */
function summarise(op: Operation): string {
  return (op.description || op.summary).split("\n")[0].trim();
}

export function documentTransitionDescription(): string {
  return (
    "Move a document through its lifecycle.\n\n" +
    targets()
      .map(([state, op]) => `- \`${state}\` — ${summarise(op)}`)
      .join("\n") +
    "\n\nEach transition is only valid from certain states and is refused with " +
    "409 otherwise. To actually email a document to its customer, use " +
    '`document_send` — `to: "sent"` only records that it happened.'
  );
}

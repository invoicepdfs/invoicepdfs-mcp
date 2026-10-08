/**
 * `find_operation` / `call_operation` — the lazy load.
 *
 * The promoted set in `manifest.ts` covers the common path. The other ~150
 * operations are reachable through these two tools rather than being listed
 * up front, because every client caps the tool list (Cursor ~40, Junie 100,
 * Copilot 128) and a server that spends 161 slots crowds out everything else
 * the user has connected.
 *
 * MCP has a protocol-level notion of listing tools on demand, but client
 * support for it is uneven, so this is implemented server-side: two tools that
 * work everywhere today, rather than a capability that works in some clients.
 *
 * `find_operation` returns the full JSON Schema of each match, so the model has
 * everything it needs to call one without a second round trip.
 */

import { OPERATIONS, type Operation } from "../operations.js";

const MAX_MATCHES: number = 8;

/**
 * Words that carry no signal about which operation is wanted.
 *
 * Without this, "how do I cancel a recurring invoice" found nothing while
 * "cancel a recurring invoice" worked: the query words that make a sentence a
 * question are exactly the ones absent from an API description. Models phrase
 * queries as sentences, so this was most of them.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "how", "do", "does", "can", "could", "would", "should", "what", "which",
  "who", "when", "where", "why", "is", "are", "was", "were", "be", "am",
  "the", "an", "some", "any", "all", "my", "me", "mine", "our", "your",
  "want", "need", "like", "show", "give", "tell", "find", "look", "see",
  "please", "help", "to", "for", "of", "in", "on", "at", "by", "with",
  "from", "about", "into", "and", "or", "but", "if", "then", "there",
  "here", "it", "its", "this", "that", "these", "those", "exist", "exists",
]);

function terms(query: string): string[] {
  const words: string[] = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
  const meaningful: string[] = words.filter((t) => !STOPWORDS.has(t));
  // If every word was a stopword, fall back to the raw words rather than
  // returning nothing at all.
  return meaningful.length ? meaningful : words;
}

/** Rank by where the query hits: name beats tag beats prose. */
function score(op: Operation, searchTerms: string[]): number {
  const id: string = op.operationId.toLowerCase();
  const tags: string = op.tags.join(" ").toLowerCase();
  const text: string = `${op.summary} ${op.description}`.toLowerCase();

  let total = 0;
  let hits = 0;
  let strong = false;
  for (const term of searchTerms) {
    let hit = false;
    if (id === term) {
      total += 100;
      hit = strong = true;
    } else if (id.includes(term)) {
      total += 20;
      hit = strong = true;
    }
    if (tags.includes(term)) {
      total += 8;
      hit = strong = true;
    }
    if (text.includes(term)) {
      total += 2;
      hit = true;
    }
    if (hit) hits++;
  }

  // Partial matches are allowed, but something has to land on the name or the
  // tag — matching only prose put every operation mentioning "invoice" in
  // range of every query. Coverage then breaks the tie, so an operation
  // matching three of the query's words outranks one matching a single word.
  if (!strong) return 0;
  return total * (1 + hits / searchTerms.length);
}

export interface OperationMatch {
  operation: string;
  method: string;
  path: string;
  tags: string[];
  description: string;
  inputSchema: Record<string, unknown>;
}

export function findOperation(query: string): {
  matches: OperationMatch[];
  searched: number;
  note?: string;
} {
  const searchTerms: string[] = terms(query);

  if (!searchTerms.length) {
    return {
      matches: [],
      searched: OPERATIONS.length,
      note: "Give a query such as 'refund a payment' or 'webhook endpoints'.",
    };
  }

  const ranked = OPERATIONS.map((op) => ({ op, points: score(op, searchTerms) }))
    .filter((r) => r.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, MAX_MATCHES);

  const matches: OperationMatch[] = ranked.map(({ op }) => ({
    operation: op.operationId,
    method: op.method.toUpperCase(),
    path: op.path,
    tags: op.tags,
    description: op.description,
    inputSchema: op.inputSchema as Record<string, unknown>,
  }));

  return {
    matches,
    searched: OPERATIONS.length,
    ...(matches.length
      ? {
          note: "Run one of these with call_operation, passing its name and the arguments its schema describes.",
        }
      : {
          note: `Nothing matched "${query}". Try naming the resource — "recurring invoice", "webhook endpoint", "tax category".`,
        }),
  };
}

export const FIND_OPERATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "What you are trying to do, in a few words — 'cancel a recurring invoice', 'list webhook deliveries', 'tax categories'.",
    },
  },
  required: ["query"],
};

export const CALL_OPERATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      description: "An operation name returned by find_operation.",
    },
    arguments: {
      type: "object",
      description:
        "The arguments for that operation, matching the inputSchema find_operation returned.",
      additionalProperties: true,
    },
  },
  required: ["operation"],
};

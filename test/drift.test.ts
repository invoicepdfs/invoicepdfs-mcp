/**
 * The guard M0 exists for.
 *
 * The manifest names operation ids as strings. Rename a handler in `app/` and
 * nothing here would fail on its own — the server would start, list a tool, and
 * 404 the first time a model used it. These tests turn that into a build
 * failure in the pull request that renames the handler.
 *
 * The surface is built from openapi.json at startup rather than generated into
 * a committed file, so there is no second copy to go stale — which removes the
 * class of bug an earlier version of this test had to guard against.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BY_ID, OPERATIONS, specPath } from "../src/operations.ts";
import { PROMOTED, PROMOTED_IDS, TRANSITIONS } from "../src/manifest.ts";
import { findOperation } from "../src/tools/findOperation.ts";
import { documentRenderSchema } from "../src/tools/documentRender.ts";
import {
  documentTransitionDescription,
  documentTransitionSchema,
} from "../src/tools/documentTransition.ts";

const here: string = dirname(fileURLToPath(import.meta.url));

/**
 * Operation ids straight from the spec, never the generated copy.
 *
 * Found through the server's own resolver rather than a path from here: the
 * spec sits two levels up in the monorepo and one level up in the published
 * mirror, and a test that only knew the first spelling would fail in the repo
 * that publishes the package.
 */
function operationIdsInSpec(): Set<string> {
  const spec = JSON.parse(readFileSync(specPath(), "utf8"));
  const verbs = new Set(["get", "post", "put", "patch", "delete"]);
  const ids = new Set<string>();
  for (const methods of Object.values(spec.paths as Record<string, any>)) {
    for (const [verb, op] of Object.entries(methods as Record<string, any>)) {
      if (verbs.has(verb) && op.operationId) ids.add(op.operationId);
    }
  }
  return ids;
}

test("every operation the manifest names still exists", () => {
  // Read from openapi.json rather than BY_ID: if the generated file is stale
  // it still contains the old name, so checking against it would pass exactly
  // when a handler has just been renamed — the case this test is for.
  const inSpec: Set<string> = operationIdsInSpec();
  // Includes the seven the transition tool hides: they are named as strings
  // too, so they drift exactly the same way and are easier to forget.
  const named: string[] = [...PROMOTED_IDS, ...Object.values(TRANSITIONS)];
  const missing: string[] = named.filter((id) => !inSpec.has(id));
  assert.deepEqual(
    missing,
    [],
    `the manifest names operations that are not in the spec: ${missing.join(", ")}. ` +
      "A handler was renamed or removed in app/ — update src/manifest.ts.",
  );
});

test("every operation in the spec reaches the tool surface", () => {
  const spec = JSON.parse(readFileSync(specPath(), "utf8"));
  const verbs = new Set(["get", "post", "put", "patch", "delete"]);
  const inSpec: string[] = [];
  for (const methods of Object.values(spec.paths as Record<string, any>)) {
    for (const [verb, op] of Object.entries(methods as Record<string, any>)) {
      if (verbs.has(verb) && op.operationId) inSpec.push(op.operationId);
    }
  }
  assert.equal(OPERATIONS.length, inSpec.length);
  const absent: string[] = inSpec.filter((id) => !BY_ID[id]);
  assert.deepEqual(absent, [], `not generated: ${absent.join(", ")}`);
});

test("no tool is offered without a description a model can act on", () => {
  const bare: string[] = OPERATIONS.filter(
    (o) => !o.description || o.description.length < 20,
  ).map((o) => o.operationId);
  assert.deepEqual(bare, [], `these would be unusable as tools: ${bare.join(", ")}`);
});

test("promoted tool names are unique and do not collide with the built-ins", () => {
  const names: string[] = [
    ...PROMOTED.map((t) => t.name),
    "document_transition",
    "find_operation",
    "call_operation",
  ];
  assert.equal(new Set(names).size, names.length, "duplicate tool name");
});

test("the tool list stays under the smallest client cap", () => {
  // Cursor is the tightest at roughly 40. Exceeding it silently truncates the
  // list, which is worse than failing here.
  // +3: document_transition, find_operation, call_operation.
  const total: number = PROMOTED.length + 3;
  assert.ok(total <= 40, `${total} tools offered — over Cursor's ~40 cap`);
});

test("document_render keeps the polling switch and the operation's own fields", () => {
  const schema = documentRenderSchema() as {
    properties: Record<string, unknown>;
  };
  assert.ok(schema.properties.pollUntilTerminal, "polling switch missing");
  assert.ok(schema.properties.data, "the operation's own fields were dropped");
});

test("find_operation reaches something outside the promoted set", () => {
  const promoted = new Set(PROMOTED_IDS);
  const result = findOperation("cancel a recurring invoice");
  assert.ok(result.matches.length > 0, "no match for a real operation");
  assert.ok(
    result.matches.some((m) => !promoted.has(m.operation)),
    "find_operation only surfaced already-promoted operations",
  );
  const first = result.matches[0];
  assert.ok(first.inputSchema, "a match must carry its input schema");
  assert.ok(first.description.length > 0, "a match must carry its description");
});

test("find_operation answers the way a model actually asks", () => {
  // This test replaces one that asserted every query word had to appear. That
  // rule made "how do I cancel a recurring invoice" return nothing while
  // "cancel a recurring invoice" worked — the words that turn a phrase into a
  // question are exactly the ones absent from an API description, and models
  // ask in sentences. The old test encoded the bug, so it passed throughout.
  const expected: Array<[string, string]> = [
    ["what tax categories exist", "list_tax_categories"],
    ["how do I cancel a recurring invoice", "cancel_recurring_invoice"],
    ["I want to see my webhook deliveries", "list_webhook_deliveries"],
    ["pause a recurring invoice", "pause_recurring_invoice"],
  ];
  for (const [query, operation] of expected) {
    const result = findOperation(query);
    assert.ok(
      result.matches.some((m) => m.operation === operation),
      `"${query}" did not surface ${operation} (got: ${result.matches.map((m) => m.operation).join(", ") || "nothing"})`,
    );
  }
});

test("find_operation still discriminates", () => {
  // The counterweight: loosening the match must not make everything match
  // everything. A term hitting only prose is not enough — something has to
  // land on the operation name or its tag.
  assert.equal(findOperation("zzzzqqq").matches.length, 0);
  assert.equal(findOperation("").matches.length, 0);

  const customers = findOperation("customers");
  assert.ok(
    customers.matches.every((m) => m.operation.includes("customer")),
    "a resource query returned operations unrelated to that resource",
  );
});


test("the lifecycle is covered once, by the transition tool alone", () => {
  // Promoting one of these as well would put two tools on the same operation,
  // which is the confusion the collapse exists to remove.
  const lifecycle = new Set(Object.values(TRANSITIONS));
  const alsoPromoted: string[] = PROMOTED_IDS.filter((id) => lifecycle.has(id));
  assert.deepEqual(
    alsoPromoted,
    [],
    `these are reachable twice — via document_transition and directly: ${alsoPromoted.join(", ")}`,
  );
  assert.equal(lifecycle.size, 7, "a lifecycle operation was dropped");
});

test("document_transition explains itself from the handlers' own words", () => {
  const description: string = documentTransitionDescription();
  for (const state of Object.keys(TRANSITIONS)) {
    assert.ok(
      description.includes(`\`${state}\``),
      `the description never mentions the "${state}" target`,
    );
  }
  // The trap this collapse exists to close: a model must not read
  // to: "sent" as a way to email the customer.
  assert.match(description, /document_send/);
  assert.ok(
    description.length > 200,
    "the description lost the per-transition detail it is built from",
  );
});

test("document_transition describes nothing in its own words", () => {
  // The point of the collapse is one tool, not a second place that explains
  // what finalizing means. Every line about a transition must be the handler's
  // own first sentence, so editing a docstring in app/ changes this tool and
  // the two can never disagree.
  const schema = documentTransitionSchema() as {
    properties: { document_id: unknown; to: { description: string } };
  };
  const described: string = schema.properties.to.description;

  for (const [state, id] of Object.entries(TRANSITIONS)) {
    const own: string = BY_ID[id].description.split("\n")[0].trim();
    assert.ok(
      described.includes(own),
      `the "${state}" line is not ${id}'s own words — it says something this tool made up`,
    );
  }

  // The id's schema comes from the API too, rather than being restated here.
  assert.deepEqual(
    schema.properties.document_id,
    (BY_ID.finalize_document.inputSchema as { properties: Record<string, unknown> })
      .properties.document_id,
  );
});

test("collapsing stops being offered if the operations stop matching", () => {
  // Seven operations share one schema only while they share one input shape.
  for (const id of Object.values(TRANSITIONS)) {
    const op = BY_ID[id];
    assert.equal(op.hasBody, false, `${id} grew a body`);
    assert.deepEqual(op.queryParams, [], `${id} grew a query parameter`);
    assert.deepEqual(op.pathParams, ["document_id"], `${id} changed its path`);
  }
});

test("the version advertised over MCP is the package's", () => {
  const pkg = JSON.parse(
    readFileSync(join(here, "..", "package.json"), "utf8"),
  ) as { version?: unknown };
  assert.equal(
    typeof pkg.version,
    "string",
    "package.json must carry a version — it is what the server announces.",
  );
  const source: string = readFileSync(join(here, "..", "src", "server.ts"), "utf8");
  assert.match(
    source,
    /version: packageVersion\(\)/,
    "server.ts must read its version from package.json. A literal there goes " +
      "stale the first time `npm version` runs, and the release then announces " +
      "the previous one over MCP.",
  );
});

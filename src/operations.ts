/**
 * The tool surface, built from openapi.json at startup.
 *
 * Nothing about an operation is written by hand: the name, the input schema,
 * the description and the HTTP call all come from the spec. The only
 * hand-written parts of this server are `manifest.ts` (which operations are
 * promoted and what they are called) and the two wrappers in `tools/`.
 *
 * Built at import rather than generated into a committed file. The earlier
 * version emitted 16k lines of TypeScript that had to be regenerated and
 * committed whenever the API changed — a second copy of the spec, with its own
 * way of going stale, which is the duplication this whole approach exists to
 * avoid. Parsing the spec costs about 10ms, once, in a process that starts once.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, any>;

const HTTP_METHODS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
]);

/**
 * Next to the package when published, two levels up when working in the repo.
 *
 * The package copy wins, because in a published install it is the only spec
 * there is. That makes it important that the copy does not exist while
 * developing: it would shadow the repo's spec and freeze the tool surface at
 * whenever the copy was made. So `prepack` makes it at publish time and
 * `.gitignore` keeps it out of the tree — it is deliberately not a build step,
 * which is exactly the mistake this comment exists to prevent repeating.
 */
export function specPath(): string {
  const here: string = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [
    join(here, "..", "openapi.json"),
    join(here, "..", "..", "openapi.json"),
  ];
  const found: string | undefined = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `openapi.json not found — looked in:\n  ${candidates.join("\n  ")}`,
    );
  }
  return found;
}

/** Every component schema this schema reaches, transitively. */
function collectRefs(node: unknown, found: Set<string>, schemas: Json): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found, schemas);
    return;
  }
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === "$ref" && typeof value === "string") {
      const name: string = value.split("/").pop()!;
      if (!found.has(name)) {
        found.add(name);
        collectRefs(schemas[name], found, schemas);
      }
      continue;
    }
    collectRefs(value, found, schemas);
  }
}

/** Rewrite component references to the local `$defs` the tool schema carries. */
function localiseRefs(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(localiseRefs);
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    out[key] =
      key === "$ref" && typeof value === "string"
        ? value.replace("#/components/schemas/", "#/$defs/")
        : localiseRefs(value);
  }
  return out;
}

export interface Operation {
  operationId: string;
  method: string;
  path: string;
  tags: string[];
  visibility: string;
  summary: string;
  description: string;
  pathParams: string[];
  queryParams: string[];
  headerParams: string[];
  hasBody: boolean;
  inputSchema: Record<string, unknown>;
}

export function buildOperations(spec: Json): Operation[] {
  const schemas: Json = spec.components?.schemas ?? {};
  const operations: Operation[] = [];

  for (const [path, methods] of Object.entries(spec.paths as Json)) {
    for (const [method, op] of Object.entries(methods as Json)) {
      if (!HTTP_METHODS.has(method)) continue;
      const operationId: string | undefined = op.operationId;
      if (!operationId) continue;

      const properties: Json = {};
      const required: string[] = [];
      const pathParams: string[] = [];
      const queryParams: string[] = [];
      const headerParams: string[] = [];

      for (const param of op.parameters ?? []) {
        const name: string = param.name;
        properties[name] = {
          ...(localiseRefs(param.schema ?? { type: "string" }) as Json),
          ...(param.description ? { description: param.description } : {}),
        };
        if (param.in === "path") {
          pathParams.push(name);
          required.push(name);
        } else if (param.in === "query") {
          queryParams.push(name);
          if (param.required) required.push(name);
        } else if (param.in === "header") {
          // Idempotency-Key is the one that matters: untracked, the executor
          // would put it in the query string where it does nothing, and a
          // retried create would duplicate.
          headerParams.push(name);
          if (param.required) required.push(name);
        }
      }

      // Body properties are merged in at the top level rather than nested under
      // `body`: a model fills a flat object far more reliably. A name that
      // collides with a parameter would silently overwrite it, so that throws.
      let hasBody = false;
      const bodyRef: Json | undefined =
        op.requestBody?.content?.["application/json"]?.schema;
      if (bodyRef) {
        hasBody = true;
        const refName: string | undefined = bodyRef.$ref?.split("/").pop();
        const bodySchema: Json = refName ? schemas[refName] : bodyRef;
        for (const [name, sub] of Object.entries(bodySchema?.properties ?? {})) {
          if (name in properties) {
            throw new Error(
              `${operationId}: body property "${name}" collides with a parameter of the same name`,
            );
          }
          properties[name] = localiseRefs(sub);
        }
        for (const name of bodySchema?.required ?? []) required.push(name);
      }

      const refs = new Set<string>();
      collectRefs(properties, refs, schemas);
      const defs: Json = {};
      for (const name of [...refs].sort()) defs[name] = localiseRefs(schemas[name]);

      operations.push({
        operationId,
        method,
        path,
        tags: op.tags ?? [],
        visibility: op["x-visibility"] ?? "public",
        summary: op.summary ?? "",
        description: (op.description ?? "").trim(),
        pathParams,
        queryParams,
        headerParams,
        hasBody,
        inputSchema: {
          type: "object",
          properties,
          ...(required.length ? { required: [...new Set(required)] } : {}),
          ...(Object.keys(defs).length ? { $defs: defs } : {}),
        },
      });
    }
  }

  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return operations;
}

export const SPEC: Json = JSON.parse(readFileSync(specPath(), "utf8"));
export const OPERATIONS: Operation[] = buildOperations(SPEC);
export const BY_ID: Record<string, Operation> = Object.fromEntries(
  OPERATIONS.map((o) => [o.operationId, o]),
);

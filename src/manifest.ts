/**
 * Which operations are promoted to first-class tools, and what they are called.
 *
 * The data lives in `manifest.json`, not here, because the hosted server
 * (`app/mcp/` in the API repo) serves the same tool surface and two copies of
 * a product decision drift. This file is the typed reader for it.
 *
 * Why promote at all rather than expose all 161: every client caps the tool
 * list. Cursor is around 40, Junie 100, Copilot 128. A server that offers 161
 * either breaks or crowds out every other server the user has connected. So a
 * small promoted set covers the common path and `find_operation` reaches the
 * rest on demand — a lazy load implemented here rather than relying on the
 * client to support one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PromotedTool {
  /** Tool name shown to the model. */
  name: string;
  /** The generated operation it runs. */
  operationId: string;
  /** Which part of the product it belongs to; see `groups` in the JSON. */
  group: string;
}

interface Manifest {
  promoted: PromotedTool[];
  transitions: Record<string, string>;
}

/**
 * Next to the package, the same shape as the spec loader in operations.ts —
 * one level up from both `dist/` and `src/`.
 */
function load(): Manifest {
  const here: string = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(here, "..", "manifest.json"), "utf8"),
  ) as Manifest;
}

const manifest: Manifest = load();

/**
 * Named `document_*` rather than `invoice_*` because the product models eight
 * document types — credit notes, quotes, receipts, purchase orders and more.
 * Naming the tools after one of them would hide the other seven from a model
 * reading only the tool list.
 */
export const PROMOTED: PromotedTool[] = manifest.promoted;

/** Operation ids the manifest names — checked against the spec at build time. */
export const PROMOTED_IDS: string[] = PROMOTED.map((t) => t.operationId);

/** Seven lifecycle operations presented as one tool, keyed by the state they reach. */
export const TRANSITIONS: Record<string, string> = manifest.transitions;

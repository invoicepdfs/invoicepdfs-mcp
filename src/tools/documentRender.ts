/**
 * `document_render` — the one tool that needs behaviour the spec cannot express.
 *
 * Two things are hand-written here and nowhere else:
 *
 * 1. **Async by default.** The render service runs at `numInstances: 1` and
 *    serves roughly two renders a second however many arrive at once. Agents
 *    fan out, so a synchronous default would hold a connection for up to 180s
 *    per call and queue behind every sibling. `mode: "async"` returns a 202
 *    immediately with a queued render.
 *
 * 2. **Poll until terminal.** Async is the right transport and the wrong
 *    ergonomics for a model: left alone it would call the render tool, get
 *    `queued`, and either give up or spin. So this polls `get_render` until the
 *    status is `completed` or `failed` and returns the finished thing, which is
 *    what the caller actually wanted.
 */

import type { InvoicePdfsClient } from "../client.js";
import { BY_ID } from "../operations.js";

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed"]);

/** Render takes ~0.4-1.5s, so start tight and back off rather than hammering. */
const BACKOFF_MS: readonly number[] = [400, 600, 900, 1200, 1500, 2000];
const DEFAULT_TIMEOUT_MS: number = 120_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RenderResult {
  render: Record<string, unknown>;
  polledFor?: string;
  note?: string;
}

export async function documentRender(
  client: InvoicePdfsClient,
  args: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<RenderResult> {
  const { pollUntilTerminal = true, ...callArgs } = args as {
    pollUntilTerminal?: boolean;
  } & Record<string, unknown>;

  // Default to async without overriding a caller who asked for sync.
  const output = { ...((callArgs.output as Record<string, unknown>) ?? {}) };
  if (!output.mode) output.mode = "async";
  callArgs.output = output;

  const first = (await client.call(
    BY_ID.render_document,
    callArgs,
  )) as Record<string, unknown>;

  const render = (first.data ?? first) as Record<string, unknown>;
  if (!pollUntilTerminal || output.mode === "sync") return { render };

  const renderId: unknown = render.id;
  if (typeof renderId !== "string") {
    // A sync response has no id to poll and is already finished.
    return { render };
  }
  if (TERMINAL.has(String(render.status))) return { render };

  const started: number = Date.now();
  const timeoutMs: number = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    const waited: number = Date.now() - started;
    if (waited > timeoutMs) {
      return {
        render,
        polledFor: `${Math.round(waited / 1000)}s`,
        note:
          `The render is still ${render.status} after ${Math.round(waited / 1000)}s. ` +
          `It has not failed — call document_get_render with id ${renderId} to check again. ` +
          `Do not start another render; that adds load to the same queue.`,
      };
    }

    await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);

    const polled = (await client.call(BY_ID.get_render, {
      render_id: renderId,
    })) as Record<string, unknown>;
    const current = (polled.data ?? polled) as Record<string, unknown>;

    if (TERMINAL.has(String(current.status))) {
      return {
        render: current,
        polledFor: `${Math.round((Date.now() - started) / 1000)}s`,
      };
    }
    Object.assign(render, current);
  }
}

/** The promoted tool's schema: the operation's own, plus the polling switch. */
export function documentRenderSchema(): Record<string, unknown> {
  const base = BY_ID.render_document.inputSchema as Record<string, unknown>;
  const properties = {
    ...(base.properties as Record<string, unknown>),
    pollUntilTerminal: {
      type: "boolean",
      default: true,
      description:
        "Wait for the render to finish and return the completed result. " +
        "Leave this on unless you specifically want the queued render back " +
        "immediately to poll yourself.",
    },
  };
  return { ...base, properties };
}

export const DOCUMENT_RENDER_DESCRIPTION: string =
  `${BY_ID.render_document.description}\n\n` +
  "This tool renders asynchronously and waits for the result, so it returns " +
  "the finished render rather than a queued one. Rendering is CPU-bound and " +
  "served by a single worker: prefer one call at a time over starting many " +
  "renders in parallel.";

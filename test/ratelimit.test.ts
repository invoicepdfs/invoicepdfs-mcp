/**
 * What a rate-limited agent is told.
 *
 * `describeError` returns prose telling a model it has been throttled and to
 * retry the same call rather than fan out. Until now nothing checked that the
 * prose survives the client's error handling and reaches the tool result — it
 * was copy nobody had read back.
 *
 * The limiter itself is not under test here. Tripping the real one means
 * bursting 100 requests a second at a server, and doing that against production
 * would throttle real traffic and burn quota off the account. So these stand up
 * a throwaway HTTP server that answers the way the API does: a real request, a
 * real 429, a real parse, and no shared resource to damage.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

import { InvoicePdfsClient, describeError } from "../src/client.ts";
import { BY_ID } from "../src/operations.ts";

let server: Server;
let baseUrl: string;
let seen: Array<{ method: string; url: string; auth: string | undefined }> = [];
let respond: (req: unknown) => { status: number; body: string } = () => ({
  status: 200,
  body: '{"data":{}}',
});

before(async () => {
  server = createServer((req, res) => {
    seen.push({
      method: req.method!,
      url: req.url!,
      auth: req.headers.authorization,
    });
    const { status, body } = respond(req);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

function client(): InvoicePdfsClient {
  seen = [];
  return new InvoicePdfsClient("inv_live_test_not_a_real_key", baseUrl);
}

test("a 429 reaches the caller as guidance, not as a stack trace", async () => {
  respond = () => ({
    status: 429,
    body: JSON.stringify({
      error: { code: "rate_limited", message: "Too many requests" },
    }),
  });

  let message = "";
  try {
    await client().call(BY_ID.list_documents, { limit: 1 });
    assert.fail("a 429 should not resolve");
  } catch (err) {
    message = describeError(err);
  }

  // What a model needs in order to do the right thing next.
  assert.match(message, /429/);
  assert.match(message, /retry/i);
  assert.match(
    message,
    /do not fan out|not.*fan out/i,
    "the guidance against fanning out is the part that stops a runaway loop",
  );
  assert.doesNotMatch(
    message,
    /undefined|\[object Object\]/,
    "the message must be readable prose, not a mangled object",
  );
});

test("a validation error keeps the field detail a model corrects itself from", async () => {
  // This is the shape that let a wrong render payload self-correct against the
  // live API: field path, expected type, array index.
  respond = () => ({
    status: 422,
    body: JSON.stringify({
      error: {
        code: "unprocessable_entity",
        message: "Request validation failed",
        details: {
          fields: [
            {
              loc: "body.data.line_items.0.quantity",
              msg: "Input should be a valid string",
              type: "string_type",
            },
          ],
        },
      },
    }),
  });

  let message = "";
  try {
    await client().call(BY_ID.render_document, { data: {} });
    assert.fail("a 422 should not resolve");
  } catch (err) {
    message = describeError(err);
  }

  assert.match(message, /422/);
  assert.match(message, /line_items\.0\.quantity/);
  assert.match(message, /valid string/);
});

test("the key is sent as a bearer token and never in the query string", async () => {
  respond = () => ({ status: 200, body: '{"data":[]}' });
  await client().call(BY_ID.list_documents, { limit: 5 });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, "Bearer inv_live_test_not_a_real_key");
  assert.doesNotMatch(
    seen[0].url,
    /inv_live/,
    "the API key must never reach the URL, which is logged and cached",
  );
  assert.match(seen[0].url, /limit=5/, "query parameters should be sent as query");
});

test("path, query and header arguments each go to their own place", async () => {
  respond = () => ({ status: 200, body: '{"data":{}}' });
  // get_render takes render_id in the path; nothing else should leak into it.
  await client().call(BY_ID.get_render, { render_id: "rnd_01ABC" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/v1/renders/rnd_01ABC");
  assert.equal(seen[0].method, "GET");
});

test("an operation whose body is all defaults still sends a body", () => {
  // create_document_render declares a required body whose every field has a
  // default, so "render this document with the defaults" is an empty object.
  // Sending no body at all returned `body: Field required` from the API — on
  // the single most likely call a model makes.
  assert.equal(BY_ID.create_document_render.hasBody, true);
});

test("a body-less operation sends no body", async () => {
  respond = () => ({ status: 200, body: '{"data":{}}' });
  const bodies: string[] = [];
  const probe = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"data":{}}');
    });
  });
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const addr = probe.address();
  if (typeof addr === "string" || addr === null) throw new Error("no port");
  const c = new InvoicePdfsClient("k", `http://127.0.0.1:${addr.port}`);

  // finalize_document takes only a path parameter.
  await c.call(BY_ID.finalize_document, { document_id: "inv_1" });
  // create_document_render takes a body of defaults.
  await c.call(BY_ID.create_document_render, { document_id: "inv_1" });

  probe.close();
  assert.equal(bodies[0], "", "a body-less operation should send nothing");
  assert.equal(bodies[1], "{}", "a defaulted body should still be sent");
});

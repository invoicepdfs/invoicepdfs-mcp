/**
 * One executor for all 161 operations.
 *
 * There is no per-operation code. Everything needed to make the call — method,
 * path, which arguments are path/query/header/body — is read from the spec at
 * startup, so adding an endpoint to the API adds a working tool with no change
 * here.
 */

import type { Operation } from "./operations.js";

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export class InvoicePdfsClient {
  constructor(
    private readonly apiKey: string,
    // Paths from the spec already carry /api/v1, so the base is the bare host.
    private readonly baseUrl: string = "https://invoicepdfs.com",
  ) {}

  async call(
    op: Operation,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    let path: string = op.path;
    const query = new URLSearchParams();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    const body: Record<string, unknown> = {};

    for (const [name, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;

      if (op.pathParams.includes(name)) {
        path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
      } else if (op.queryParams.includes(name)) {
        query.set(name, String(value));
      } else if (op.headerParams.includes(name)) {
        headers[name] = String(value);
      } else if (op.hasBody) {
        body[name] = value;
      }
      // An argument matching nothing is dropped rather than guessed at. The
      // input schema came from the spec, so this means the model invented it.
    }

    const url = `${this.baseUrl}${path}${query.size ? `?${query}` : ""}`;
    // Send the body whenever the operation declares one, even with nothing in
    // it. Several operations take a body whose fields all have defaults --
    // create_document_render is the common one -- so "render with the defaults"
    // sends {}. Omitting it there produced `body: Field required` on exactly
    // the call a model is most likely to make.
    const hasPayload: boolean = op.hasBody;
    if (hasPayload) headers["Content-Type"] = "application/json";

    const response: Response = await fetch(url, {
      method: op.method.toUpperCase(),
      headers,
      ...(hasPayload ? { body: JSON.stringify(body) } : {}),
    });

    const text: string = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON body is worth surfacing verbatim rather than masking as a
      // parse failure — it is usually a proxy error page.
    }

    if (!response.ok) {
      const envelope = (parsed as { error?: Partial<ApiError> })?.error ?? {};
      const error: ApiError = {
        status: response.status,
        code: envelope.code ?? "http_error",
        message: envelope.message ?? `HTTP ${response.status}`,
        details: envelope.details,
      };
      throw Object.assign(new Error(`${error.code}: ${error.message}`), {
        apiError: error,
      });
    }

    return parsed;
  }
}

/** The rate limit an agent is most likely to hit, made legible. */
export function describeError(err: unknown): string {
  const apiError = (err as { apiError?: ApiError })?.apiError;
  if (!apiError) return err instanceof Error ? err.message : String(err);

  if (apiError.status === 429) {
    return (
      "Rate limited (429). This account allows a fixed number of requests per " +
      "second. Wait a moment and retry the same call — do not fan out further, " +
      "and do not treat this as a failure of the request itself."
    );
  }
  const detail: string = apiError.details
    ? `\n\nDetails: ${JSON.stringify(apiError.details)}`
    : "";
  return `${apiError.code} (HTTP ${apiError.status}): ${apiError.message}${detail}`;
}

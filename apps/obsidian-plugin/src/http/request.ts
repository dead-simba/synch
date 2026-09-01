import { requestUrl } from "obsidian";

export interface HttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
}

export interface HttpResponseLike {
  status: number;
  json?: unknown;
  /** Raw body, kept so a non-JSON error can still be reported in full. */
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

export interface HttpClient {
  request(input: HttpRequestInput): Promise<HttpResponseLike>;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export class ObsidianHttpClient implements HttpClient {
  async request(input: HttpRequestInput): Promise<HttpResponseLike> {
    const response = await requestUrl({
      url: input.url,
      method: input.method ?? "GET",
      throw: false,
      headers: input.headers,
      body: input.body,
    });

    // `json` is a lazy getter that parses on access, so reading it on a body
    // that is not JSON throws a SyntaxError from wherever it happened to be
    // touched. Cloudflare returns plain text for infrastructure failures - an
    // overloaded Worker answers `error code: 1102` - and the user was shown
    // "Unexpected token 'e' ... is not valid JSON", which describes our parser
    // rather than their problem. Parse once, here, and keep the raw body so the
    // server's actual words survive.
    let json: unknown;
    try {
      json = response.json;
    } catch {
      json = undefined;
    }

    let text: string | undefined;
    try {
      text = response.text;
    } catch {
      text = undefined;
    }

    return {
      status: response.status,
      json,
      text,
      arrayBuffer: response.arrayBuffer,
    };
  }
}

export const defaultHttpClient: HttpClient = new ObsidianHttpClient();

export function extractErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message;
  }
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error;
  }

  return "";
}

export function extractErrorCode(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error;
  }
  if (typeof record.code === "string" && record.code.trim()) {
    return record.code;
  }

  return "";
}

export function createApiRequestError(
  response: HttpResponseLike,
  fallbackMessage: string,
): ApiRequestError {
  const message =
    extractErrorMessage(response.json) ||
    // A non-JSON body is usually infrastructure speaking, not the API. Its own
    // words ("error code: 1102") are far more use than a generic fallback.
    summarizeNonJsonBody(response.text) ||
    fallbackMessage;
  const code = extractErrorCode(response.json) || `http_${response.status}`;
  return new ApiRequestError(response.status, code, message);
}

function summarizeNonJsonBody(text: string | undefined): string {
  const trimmed = text?.trim();
  if (!trimmed || trimmed.startsWith("<")) {
    // An HTML error page has no sentence worth quoting at the user.
    return "";
  }

  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

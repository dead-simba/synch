import { describe, expect, it } from "vitest";

import { createApiRequestError } from "./request";

/**
 * Cloudflare answers plain text when the infrastructure itself fails - an
 * overloaded Worker returns `error code: 1102`. Reading `.json` on that body
 * threw a SyntaxError from wherever it was touched, so the user saw
 * "Unexpected token 'e', "error code: 1102" is not valid JSON": a message
 * about our parser instead of their problem.
 */
describe("errors from a non-JSON response", () => {
  it("reports what the server actually said", () => {
    const error = createApiRequestError(
      { status: 500, json: undefined, text: "error code: 1102" },
      "sync request failed",
    );

    expect(error.message).toBe("error code: 1102");
    expect(error.message).not.toContain("not valid JSON");
  });

  it("prefers a structured API message when there is one", () => {
    const error = createApiRequestError(
      { status: 413, json: { error: "quota_exceeded", message: "vault storage quota exceeded" } },
      "sync request failed",
    );

    expect(error.message).toBe("vault storage quota exceeded");
    expect(error.code).toBe("quota_exceeded");
  });

  it("does not quote an HTML error page at the user", () => {
    const error = createApiRequestError(
      { status: 502, json: undefined, text: "<!DOCTYPE html><html><body>Bad gateway</body></html>" },
      "sync request failed",
    );

    expect(error.message).toBe("sync request failed");
  });

  it("truncates a long body rather than filling the notice", () => {
    const error = createApiRequestError(
      { status: 500, json: undefined, text: "x".repeat(500) },
      "sync request failed",
    );

    expect(error.message.length).toBeLessThan(210);
    expect(error.message.endsWith("...")).toBe(true);
  });
});

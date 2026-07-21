/**
 * Static HTTP routing edge cases for the browser dev app.
 * Covers PRD §11 (C-APP-08): a request without a URL falls back to the shell route.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test } from "vitest";
import { createHttpHandler } from "../../src/app/web-http.ts";

describe("web http routing", () => {
  test("C-APP-08 a request without a url serves the app shell", () => {
    const handler = createHttpHandler({ cwd: "/w", token: "t" });
    const response = fakeResponse();
    handler({ url: undefined } as IncomingMessage, response as unknown as ServerResponse);
    expect(response.status).toBe(200);
    expect(response.body).toContain("Elwood Dev");
  });

  test("C-APP-08 an unknown path returns 404", () => {
    const handler = createHttpHandler({ cwd: "/w", token: "t" });
    const response = fakeResponse();
    handler({ url: "/missing" } as IncomingMessage, response as unknown as ServerResponse);
    expect(response.status).toBe(404);
  });
});

function fakeResponse() {
  return {
    status: 0,
    body: "",
    writeHead(status: number): void {
      this.status = status;
    },
    end(body?: string): void {
      this.body = body ?? "";
    },
  };
}

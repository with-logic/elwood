/**
 * Static HTTP routing for the browser dev app (PRD §11, C-APP-08): the token-bearing
 * shell is served only to a loopback Host for the bound port, and a request without a
 * URL falls back to the shell route.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test } from "vitest";
import { createHttpHandler } from "../../dev/web/http.ts";

describe("web http routing", () => {
  test("C-APP-08 a request without a url serves the app shell", () => {
    const handler = createHttpHandler({ cwd: "/w", token: "t", port: 4317 });
    const response = fakeResponse();
    handler(request(undefined), response as unknown as ServerResponse);
    expect(response.status).toBe(200);
    expect(response.body).toContain("Elwood Dev");
  });

  test("C-APP-08 an unknown path returns 404", () => {
    const handler = createHttpHandler({ cwd: "/w", token: "t", port: 4317 });
    const response = fakeResponse();
    handler(request("/missing"), response as unknown as ServerResponse);
    expect(response.status).toBe(404);
  });

  test("C-APP-08 the shell (and its token) is refused for a non-loopback Host", () => {
    // A DNS-rebound or LAN request must not receive the embedded WebSocket token.
    const handler = createHttpHandler({ cwd: "/w", token: "secret", port: () => 4317 });
    const foreign = [request("/", "evil.test:4317"), request("/", "localhost:9999")];
    foreign.push({ url: "/", headers: {} } as IncomingMessage); // no Host header at all
    for (const incoming of foreign) {
      const response = fakeResponse();
      handler(incoming, response as unknown as ServerResponse);
      expect(response.status).toBe(403);
      expect(response.body).not.toContain("secret");
    }
    const allowed = fakeResponse();
    handler(request("/", "127.0.0.1:4317"), allowed as unknown as ServerResponse);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toContain("secret");
  });
});

function request(url: string | undefined, host = "localhost:4317") {
  return { url, headers: { host } } as IncomingMessage;
}

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

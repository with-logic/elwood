/**
 * Browser dev app connection guards (PRD §11, C-APP-08): WebSocket upgrades and the
 * token-bearing app shell are limited to loopback hosts for the bound port.
 */

import { createServer } from "node:http";
import { describe, expect, test } from "vitest";
import {
  createBrowserToken,
  createGuardedWebSocketServer,
  guardUpgrade,
  isAllowedUpgrade,
  isLocalHost,
  resolvePort,
} from "../../dev/web/security.ts";

const request = (url: string, host = "localhost:4317", origin = "http://localhost:4317") =>
  ({ url, headers: { host, origin } }) as never;

describe("web dev app connection guards", () => {
  test("C-APP-08 sockets require a loopback host, a loopback origin, and the token", () => {
    expect(createBrowserToken().length).toBeGreaterThan(0);
    expect(isAllowedUpgrade(request("/?token=secret"), "secret", 4317)).toBe(true);
    expect(isAllowedUpgrade(request("/?token=bad"), "secret", 4317)).toBe(false);
    expect(isAllowedUpgrade(request("/?token=secret", "0.0.0.0:4317"), "secret", 4317)).toBe(false);
    expect(
      isAllowedUpgrade(
        request("/?token=secret", "localhost:4317", "https://evil.test"),
        "secret",
        4317,
      ),
    ).toBe(false);
    expect(
      isAllowedUpgrade(request("/?token=secret", "localhost:4317", "not a url"), "secret", 4317),
    ).toBe(false);
  });

  test("C-APP-08 isLocalHost accepts only localhost/127.0.0.1 on the bound port", () => {
    expect(isLocalHost("localhost:4317", 4317)).toBe(true);
    expect(isLocalHost("127.0.0.1:4317", 4317)).toBe(true);
    expect(isLocalHost("localhost:4318", 4317)).toBe(false);
    expect(isLocalHost("evil.test:4317", 4317)).toBe(false);
    expect(resolvePort(() => 9)).toBe(9);
    expect(resolvePort(8)).toBe(8);
  });

  test("C-APP-08 the guarded WebSocket server verifies clients with the upgrade guard", async () => {
    expect(guardUpgrade("secret", 4317)({ req: request("/?token=secret") })).toBe(true);
    const wss = createGuardedWebSocketServer(createServer(), "secret", () => 4317);
    expect(typeof wss.options.verifyClient).toBe("function");
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});

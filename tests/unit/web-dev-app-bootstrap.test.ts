/**
 * Coverage for the browser dev app factory, entrypoint, and socket utilities.
 * Covers PRD §11 (C-APP-08): startWebDevApp/bootstrapIfMain/createWebDevApp
 * defaults, sendSocket gating, and boundPort resolution.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  bootstrapIfMain,
  boundPort,
  createWebDevApp,
  sendSocket,
  startWebDevApp,
  type WebDevApp,
} from "../../src/app/web-dev.ts";
import { waitFor } from "./web-dev-app-helpers.ts";

const running: WebDevApp[] = [];

afterEach(async () => {
  while (running.length) await running.pop()?.shutdown();
});

describe("browser dev app bootstrap", () => {
  test("C-APP-08 startWebDevApp installs shutdown handling, listens, and logs", async () => {
    let installed: (() => Promise<void>) | null = null;
    const lines: string[] = [];
    const app = startWebDevApp({
      port: 0,
      token: "boot",
      installShutdown: (cleanup) => {
        installed = cleanup;
      },
      log: (line) => lines.push(line),
    });
    running.push(app);
    const p = await app.listen();
    expect(p).toBeGreaterThanOrEqual(0);
    expect(app.server.listening).toBe(true);
    await waitFor(() => lines.length > 0);
    expect(lines[0]).toContain("Elwood dev app:");
    expect(installed).not.toBeNull();
    // The installed cleanup really tears the app down.
    await (installed as unknown as () => Promise<void>)();
  });

  test("C-APP-08 bootstrapIfMain returns null unless the module is the entry", () => {
    expect(bootstrapIfMain({ url: "file:///definitely/not/the/entry.ts" })).toBeNull();
  });

  test("C-APP-08 createWebDevApp applies defaults without binding a port", async () => {
    // Construct-only (no listen): exercises the cwd/port/token default branches
    // without opening the real 4317 port.
    const app = createWebDevApp();
    expect(app.server.listening).toBe(false);
    await app.shutdown();
  });

  test("C-APP-08 sendSocket writes only to an OPEN socket", () => {
    const sent: string[] = [];
    const socket = (readyState: number) =>
      ({ readyState, OPEN: 1, send: (data: string) => sent.push(data) }) as never;
    sendSocket(socket(1), { type: "status", status: "ready" });
    sendSocket(socket(2), { type: "status", status: "ready" });
    expect(sent).toHaveLength(1);
  });

  test("C-APP-08 boundPort reads a TCP port and falls back otherwise", () => {
    expect(
      boundPort({ address: () => ({ port: 8080, family: "IPv4", address: "127.0.0.1" }) }, 1),
    ).toBe(8080);
    expect(boundPort({ address: () => null }, 4317)).toBe(4317);
    expect(boundPort({ address: () => "/tmp/pipe" }, 4317)).toBe(4317);
  });

  test("C-APP-08 bootstrapIfMain starts the app when the url matches argv entry", async () => {
    const argv = process.argv;
    const restored = [...argv];
    const originalPort = process.env["ELWOOD_DEV_PORT"];
    try {
      argv[1] = "/tmp/entry.ts";
      process.env["ELWOOD_DEV_PORT"] = "0"; // ephemeral port; avoid the real 4317
      const app = bootstrapIfMain({ url: "file:///tmp/entry.ts" });
      expect(app).not.toBeNull();
      if (app) {
        running.push(app);
        await waitFor(() => app.server.listening);
      }
    } finally {
      argv.splice(0, argv.length, ...restored);
      if (originalPort === undefined) delete process.env["ELWOOD_DEV_PORT"];
      else process.env["ELWOOD_DEV_PORT"] = originalPort;
    }
  });
});

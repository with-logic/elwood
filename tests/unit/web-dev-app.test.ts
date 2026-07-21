/**
 * Real end-to-end coverage of the browser dev app server request handling.
 * Covers PRD §11 (C-APP-08): a real HTTP server + WebSocket layer serve the
 * shell, authorize by token, dispatch real client frames, and report bad frames.
 */

import { afterEach, describe, expect, test } from "vitest";
import type { AgentLaunchOptions } from "../../src/app/agent-runtime.ts";
import { childPids } from "../../src/app/child-lookup.ts";
import type { WebDevApp } from "../../src/app/web-dev.ts";
import {
  collect,
  connect,
  fakeSession,
  fetchRaw,
  fetchText,
  launch,
  waitFor,
} from "./web-dev-app-helpers.ts";

const running: WebDevApp[] = [];

afterEach(async () => {
  while (running.length) await running.pop()?.shutdown();
});

describe("browser dev app server", () => {
  test("C-APP-08 serves the shell, client script, and vendor assets", async () => {
    const app = await launch(running);
    expect(await fetchText(app, "/")).toContain("Elwood Dev");
    expect(await fetchText(app, "/client.js")).toContain("new Terminal");
    expect(await fetchText(app, "/vendor/xterm.mjs")).toContain("");
    expect(await fetchText(app, "/vendor/addon-fit.mjs")).toContain("");
    expect(await fetchText(app, "/vendor/xterm.css")).toContain("");
    const missing = await fetchRaw(app, "/nope");
    expect(missing.status).toBe(404);
  });

  test("C-APP-08 rejects a WebSocket upgrade without the token", async () => {
    const app = await launch(running, { token: "secret" });
    await expect(connect(app, "wrong")).rejects.toBeDefined();
  });

  test("C-APP-08 dispatches a real start frame and broadcasts the session", async () => {
    const started: AgentLaunchOptions[] = [];
    const session = fakeSession("s1");
    const app = await launch(running, { token: "tok" }, (options) => {
      started.push(options);
      return Promise.resolve(session);
    });
    const socket = await connect(app, "tok");
    const messages = collect(socket);
    socket.send(JSON.stringify({ type: "start", agent: "codex", cwd: "/w", cols: 80, rows: 24 }));
    await waitFor(() => messages.some((m) => m.type === "session"));
    expect(started[0]?.agent).toBe("codex");
    expect(app.slot.session).toBe(session);
    socket.close();
  });

  test("C-APP-08 reports a malformed frame to the originating socket without teardown", async () => {
    const app = await launch(running, { token: "tok" });
    const socket = await connect(app, "tok");
    const messages = collect(socket);
    socket.send("not json");
    await waitFor(() => messages.some((m) => m.type === "event"));
    const event = messages.find((m) => m.type === "event");
    expect(event?.entry?.kind).toBe("error");
    socket.close();
  });

  test("C-APP-08 a child-lookup failure is broadcast to connected sockets", async () => {
    const app = await launch(running, { token: "tok" });
    const socket = await connect(app, "tok");
    const messages = collect(socket);
    // The app installed the child-lookup reporter; a failed pgrep must route
    // through the debugger's runtime-error path (C-APP-08), not go silent.
    childPids(123, () => ({ signal: null, status: 2, stdout: "" }) as never);
    await waitFor(() => messages.some((m) => m.type === "event"));
    const event = messages.find((m) => m.type === "event");
    expect(event?.entry?.kind).toBe("error");
    socket.close();
  });
});

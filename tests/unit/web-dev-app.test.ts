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
    // Assert a real signature per vendor asset, not `toContain("")` (which passes for
    // any body): an empty or wrong asset would leave the browser app unusable but a
    // substring-of-"" check green. Each asset must be 200, non-empty, and identifiable.
    for (const [path, signature] of [
      ["/vendor/xterm.mjs", "xterm.js authors"],
      ["/vendor/addon-fit.mjs", "xterm.js authors"],
      ["/vendor/xterm.css", ".xterm"],
    ] as const) {
      const res = await fetchRaw(app, path);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body.length).toBeGreaterThan(100);
      expect(body).toContain(signature);
    }
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

  test("C-APP-08 a replaced session's failed teardown is broadcast, not silently dropped", async () => {
    // Start session A (teardown throws), then start B: the slot installs B and tears
    // down A, whose failure must surface as a runtime error to connected sockets so a
    // stuck PTY stays visible — never a silent drop.
    const a = fakeSession("s1", { teardown: () => Promise.reject(new Error("stuck pty")) });
    const b = fakeSession("s2");
    const sessions = [a, b];
    let i = 0;
    const app = await launch(running, { token: "tok" }, () =>
      Promise.resolve(sessions[i++] as never),
    );
    const socket = await connect(app, "tok");
    const messages = collect(socket);
    const startFrame = { type: "start", agent: "codex", cwd: "/w", cols: 80, rows: 24 };
    socket.send(JSON.stringify(startFrame));
    await waitFor(() => app.slot.session === a);
    socket.send(JSON.stringify(startFrame)); // replaces A with B; A's teardown throws
    const summaryOf = (m: (typeof messages)[number]) =>
      (m.entry as { summary?: string } | undefined)?.summary ?? "";
    await waitFor(() =>
      messages.some(
        (m) => m.type === "event" && /Session teardown failed \(s1\)/.test(summaryOf(m)),
      ),
    );
    expect(app.slot.session).toBe(b); // B still took the slot
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

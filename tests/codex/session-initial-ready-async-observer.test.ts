/** Initial-ready Promise observers remain contained without changing sync fallback (C-HOOK-22). */
import { afterEach, expect, test, vi } from "vitest";
import type { CodexSessionImpl } from "../../src/codex/session/instance.ts";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  "status",
  "activity",
] as const)("C-HOOK-22 Codex initial-ready %s rejection is observed without delaying input", async (channel) => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const deferred = Promise.withResolvers<void>();
  // Keep the baseline probe from becoming an unhandled process rejection;
  // only the session's observer sink can produce the diagnostic below.
  void deferred.promise.catch(() => undefined);
  const warnings: unknown[] = [];
  if (channel === "status")
    session.on("status", (event) => (event.status === "ready" ? deferred.promise : undefined));
  else
    session.on("activity", (event) =>
      event.kind === "status" && event.status === "ready" ? deferred.promise : undefined,
    );
  session.on("warning", (event) => warnings.push(event));
  try {
    const queued = session.sendMessage("hello");
    await becomeReady(session.elwoodSessionId, cwd);
    await queued;
    expect(ptys[0]!.writes[0]).toBe("\u001b[200~hello\u001b[201~");
    deferred.reject(new Error("private readiness observer"));
    await vi.waitFor(() =>
      expect(warnings).toEqual([
        expect.objectContaining({ code: "hook_observer_failed", phase: "lifecycle" }),
      ]),
    );
    expect(JSON.stringify(warnings)).not.toContain("private readiness observer");
  } finally {
    deferred.resolve();
    await session.teardown();
  }
});

test("C-API-42 standalone Codex initial readiness reports a lifecycle observer failure", async () => {
  installFakes();
  const session = (await startCodex({ cwd: tempDir() })) as CodexSessionImpl;
  const deferred = Promise.withResolvers<void>();
  void deferred.promise.catch(() => undefined);
  const warnings: unknown[] = [];
  session.on("status", (event) => (event.status === "ready" ? deferred.promise : undefined));
  session.on("warning", (event) => warnings.push(event));
  try {
    const queued = session.sendMessage("hello");
    session.completeInitialReady();
    await queued;
    deferred.reject(new Error("private readiness observer"));
    await vi.waitFor(() =>
      expect(warnings).toEqual([
        expect.objectContaining({ code: "initial_ready_observer_failed", phase: "lifecycle" }),
      ]),
    );
    expect(JSON.stringify(warnings)).not.toContain("private readiness observer");
  } finally {
    deferred.resolve();
    await session.teardown();
  }
});

test("C-HOOK-22 SessionStart shares one warning for hook and readiness failures", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const deferred = Promise.withResolvers<void>();
  void deferred.promise.catch(() => undefined);
  const warnings: string[] = [];
  session.on("status", (event) => (event.status === "ready" ? deferred.promise : undefined));
  session.on("hook", (event) => {
    if (event.hook_event_name === "SessionStart") throw new Error("private hook observer");
  });
  session.on("warning", (event) =>
    warnings.push(`${event.code}:${"phase" in event ? event.phase : ""}`),
  );
  try {
    const queued = session.sendMessage("hello");
    await becomeReady(session.elwoodSessionId, cwd);
    await queued;
    expect(warnings).toEqual(["hook_observer_failed:hook"]);
    deferred.reject(new Error("private readiness observer"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warnings).toEqual(["hook_observer_failed:hook"]);
  } finally {
    deferred.resolve();
    await session.teardown();
  }
});

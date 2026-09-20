/** Promise observer failures cannot escape Claude hook delivery (C-HOOK-22). */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

function rejectedObserver() {
  const rejected = Promise.reject(new Error("private async observer"));
  // Keep the old-source proof focused on the missing diagnostic, not Vitest's
  // global unhandled-rejection handler. Return the original rejected Promise.
  void rejected.catch(() => {});
  return rejected;
}

function expectedDiagnostic(id: string, phase: string) {
  const warning = {
    elwoodSessionId: id,
    agent: "claude",
    source: "lifecycle",
    code: "hook_observer_failed",
    severity: "warning",
    message: "A Claude hook notification failed; hook decisions and lifecycle were preserved.",
    phase,
    raw: `hook_observer_failed phase=${phase}`,
  };
  return {
    warnings: [warning],
    activities: [
      {
        elwoodSessionId: id,
        agent: "claude",
        source: "lifecycle",
        kind: "warning",
        label: "hook_observer_failed",
        text: warning.message,
        raw: warning,
      },
    ],
  };
}

test.each([
  "hook",
  "activity",
  "status",
] as const)("C-HOOK-22 a rejected %s observer preserves Stop and reports once", async (channel) => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  await session.sendPrompt("busy");
  const warnings: unknown[] = [];
  const activities: unknown[] = [];
  session.on("activity", (event) => {
    if (event.kind === "warning") activities.push(event);
  });
  session.on("warning", rejectedObserver);
  session.on("warning", (event) => warnings.push(event));
  session.on(channel, rejectedObserver);
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(session.status).toBe("ready");
  expect({ warnings, activities }).toEqual(
    expectedDiagnostic(session.elwoodSessionId, channel === "status" ? "lifecycle" : channel),
  );
  expect(JSON.stringify([warnings, activities])).not.toContain("private");
});

test("C-HOOK-22 a pending observer never delays the reply and late rejections warn once", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({
    cwd,
    hooks: { Stop: () => ({ decision: "block", reason: "wait" }) },
  });
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  void first.promise.catch(() => {});
  void second.promise.catch(() => {});
  const warnings: unknown[] = [];
  const activities: unknown[] = [];
  session.on("activity", (event) => {
    if (event.kind === "warning") activities.push(event);
  });
  session.on("warning", (event) => warnings.push(event));
  session.on("hook", () => first.promise);
  session.on("activity", () => second.promise);
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  expect(result.stdout).toBe('{"decision":"block","reason":"wait"}\n');
  expect(warnings).toEqual([]);
  first.reject(new Error("private first rejection"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  second.reject(new Error("private second rejection"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect({ warnings, activities }).toEqual(expectedDiagnostic(session.elwoodSessionId, "hook"));
  expect(JSON.stringify([warnings, activities])).not.toContain("private");
});

test("C-HOOK-22 fulfilled notification promises do not warn", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  const warnings: unknown[] = [];
  const activities: unknown[] = [];
  session.on("activity", (event) => {
    if (event.kind === "warning") activities.push(event);
  });
  session.on("warning", (event) => warnings.push(event));
  session.on("hook", () => Promise.resolve());
  await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(warnings).toEqual([]);
  expect(activities).toEqual([]);
});

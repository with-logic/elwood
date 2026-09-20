/** Immediate shutdown joins already-scheduled startup diagnostics (C-API-14/C-API-20). */
import { afterEach, expect, test } from "vitest";
import type { ElwoodCommonEventMap } from "../../src/core/types.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

type Listener<E extends keyof ElwoodCommonEventMap> = (
  event: E,
  handler: (payload: ElwoodCommonEventMap[E]) => void,
) => unknown;

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
});

for (const adapter of [
  { name: "claude", start: startClaude, helpers: claude },
  { name: "codex", start: startCodex, helpers: codex },
] as const) {
  test.each([
    "stop",
    "kill",
    "teardown",
  ] as const)(`C-API-20 ${adapter.name} immediate %s resolves after scheduled diagnostics and exit`, async (verb) => {
    adapter.helpers.installFakes();
    setCommandRunnerForTests((_command, args) => ({
      status: 0,
      stderr: "",
      stdout: args.includes("--help") ? "--dangerously-bypass-hook-trust" : "unknown build",
    }));
    const session = await adapter.start({ cwd: adapter.helpers.tempDir() });
    const order: string[] = [];
    const on: Listener<"warning"> &
      Listener<"activity"> &
      Listener<"terminal:exit"> &
      Listener<"status"> = session.on.bind(session);
    on("warning", ({ code }) => {
      if (code === "version_unparseable") order.push("warning");
    });
    on("activity", (event) => {
      if (event.kind === "warning") order.push("warning:activity");
    });
    on("terminal:exit", () => order.push("exit"));
    on("status", () => order.push("status"));
    try {
      await session[verb]();
      order.push("resolved");
      expect(order).toEqual(["warning", "warning:activity", "exit", "status", "resolved"]);
      expect(adapter.helpers.ptys[0]!.killSignals).toHaveLength(1);
    } finally {
      await session.teardown();
    }
  });
}

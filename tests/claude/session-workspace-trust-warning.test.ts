/** Report live Claude dialog observer failures without affecting native trust (C-ATTN-08). */
import { realpathSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import {
  type ElwoodActivityEvent,
  type ElwoodDialogEvent,
  type ElwoodWarningEvent,
  startClaude,
} from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

const failureText = "private listener contents";

test.each([
  "broadcast",
  "replay",
] as const)("C-ATTN-08 a failing Claude dialog %s warns once and preserves delivery", async (delivery) => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const warnings = vi.fn<(warning: ElwoodWarningEvent) => void>();
  const events = vi.fn();
  const activity = vi.fn<(event: ElwoodActivityEvent) => void>();
  const failure = vi.fn(() => {
    const error = new Error(failureText);
    if (delivery === "broadcast") throw error;
    return Promise.reject(error);
  });
  session.on("warning", warnings);
  session.on("activity", activity);
  if (delivery === "broadcast") session.on("dialog", failure);
  session.on("dialog", events);
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    await expect.poll(() => events.mock.calls.map(([event]) => event.phase)).toEqual(["raised"]);
    if (delivery === "replay") session.on("dialog", failure);
    await expect
      .poll(() => warnings.mock.calls)
      .toMatchObject([
        [
          {
            code: "dialog_observer_failed",
            agent: "claude",
            elwoodSessionId: session.elwoodSessionId,
          },
        ],
      ]);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(failureText);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(cwd);
    expect(activity.mock.calls).toContainEqual([
      expect.objectContaining({ kind: "warning", label: "dialog_observer_failed" }),
    ]);
    expect(await session.listDialogs()).toHaveLength(1);

    ptys[0]!.emitData(`\x1b[2J\x1b[H${claudeTty(claudeComposer)}`);
    await session.terminal.settled();
    await expect
      .poll(() => events.mock.calls.map(([event]) => event.phase))
      .toEqual(["raised", "closed"]);
    expect(failure).toHaveBeenCalledTimes(2);
    await setImmediate();
    expect(warnings).toHaveBeenCalledOnce();
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 Claude dialog rejections after teardown are contained without a warning", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const warnings = vi.fn();
  const pending = Promise.withResolvers<void>();
  const rejectLater = vi.fn(({ phase }: ElwoodDialogEvent<"claude">) =>
    phase === "raised" ? pending.promise : undefined,
  );
  session.on("warning", warnings);
  session.on("dialog", rejectLater);
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    await expect.poll(() => rejectLater.mock.calls.length).toBe(1);
    await session.teardown();
    pending.reject(new Error(failureText));
    await setImmediate();
    expect(warnings).not.toHaveBeenCalled();
  } finally {
    pending.resolve();
    await session.teardown();
  }
});

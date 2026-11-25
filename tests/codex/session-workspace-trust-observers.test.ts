/** Verify dialog observer diagnostics in the live Codex session (C-ATTN-08). */
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { CodexSessionApi, ElwoodActivityEvent, ElwoodWarningEvent } from "../../src/index.ts";
import { resetFakes } from "./helpers.ts";
import { menu, setup } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

const secret = "private listener exception";
const failures = [
  [
    "throw",
    () => {
      throw new Error(secret);
    },
  ],
  ["reject", () => Promise.reject(new Error(secret))],
] as const;

function observe(session: CodexSessionApi) {
  const warnings = vi.fn<(event: ElwoodWarningEvent) => void>();
  const activity = vi.fn<(event: ElwoodActivityEvent) => void>();
  session.on("warning", warnings);
  session.on("activity", (event) => {
    if (event.label === "dialog_observer_failed") activity(event);
  });
  return { warnings, activity };
}

test.each(
  failures,
)("C-ATTN-08 contains a live dialog listener %s and emits one diagnostic pair", async (_, fail) => {
  const { cwd, session, render } = await setup();
  const { warnings, activity } = observe(session);
  const delivered = vi.fn();
  const first = vi.fn(fail);
  const second = vi.fn(fail);
  session.on("dialog", first);
  session.on("dialog", second);
  session.on("dialog", delivered);
  try {
    await render(menu(cwd));
    await expect.poll(() => activity.mock.calls.length).toBe(1);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledOnce();
    const expected = diagnostic(session);
    expect(warnings).toHaveBeenCalledExactlyOnceWith(expected.warning);
    expect(activity).toHaveBeenCalledExactlyOnceWith(expected.activity);
  } finally {
    await session.teardown();
  }
});

test.each(
  failures,
)("C-ATTN-08 contains a replay listener %s and emits one diagnostic pair", async (_, fail) => {
  const { cwd, session, render } = await setup();
  const { warnings, activity } = observe(session);
  session.on("warning", fail);
  session.on("activity", (event) =>
    event.label === "dialog_observer_failed" ? fail() : undefined,
  );
  const delivered = vi.fn();
  session.on("dialog", delivered);
  try {
    await render(menu(cwd));
    await expect.poll(() => delivered.mock.calls.length).toBe(1);
    const first = vi.fn(fail);
    const second = vi.fn(fail);
    session.on("dialog", first);
    session.on("dialog", second);
    await expect.poll(() => second.mock.calls.length).toBe(1);
    await setImmediate();
    expect(first).toHaveBeenCalledOnce();
    const expected = diagnostic(session);
    expect(warnings).toHaveBeenCalledExactlyOnceWith(expected.warning);
    expect(activity).toHaveBeenCalledExactlyOnceWith(expected.activity);
  } finally {
    await session.teardown();
  }
});

function diagnostic(session: CodexSessionApi) {
  const warning = {
    agent: "codex",
    code: "dialog_observer_failed",
    elwoodSessionId: session.elwoodSessionId,
    message: "A dialog notification listener failed.",
    raw: "dialog_observer_failed",
    severity: "warning",
    source: "lifecycle",
  } satisfies ElwoodWarningEvent;
  return {
    warning,
    activity: {
      agent: "codex",
      elwoodSessionId: session.elwoodSessionId,
      kind: "warning",
      label: "dialog_observer_failed",
      raw: warning,
      source: "lifecycle",
      text: warning.message,
    } satisfies ElwoodActivityEvent,
  };
}

test("C-ATTN-08 contains listener rejection after closing without reporting a warning", async () => {
  const { cwd, session, render } = await setup();
  const { warnings, activity } = observe(session);
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  session.on("dialog", (event) => {
    if (event.phase !== "raised") return;
    entered.resolve();
    return pending.promise;
  });
  try {
    await render(menu(cwd));
    await entered.promise;
    await session.stop();
    pending.reject(new Error(secret));
    await setImmediate();
    expect(warnings).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  } finally {
    pending.resolve();
    await session.teardown();
  }
});

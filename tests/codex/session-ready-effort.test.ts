/**
 * A requested effort holds Codex readiness and queued writes until its footer shows a label
 * other than `default`, or until 50 s after launch (never before the deadline), which releases
 * them with a content-free `codex_effort_unconfirmed` warning before a host's default
 * `waitForStatus` can expire (PRD §5.3, §5.7, C-API-28).
 */
import { afterEach, expect, test, vi } from "vitest";
import { resumeCodex, type StartCodexOptions, startCodex } from "../../src/index.ts";
import {
  deadlineOnDefaultFooter,
  effortDefault,
  effortLow,
  initialSize,
  paint,
  paste,
  sentinel,
} from "./effort-footer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

/** The two routes by which a launch requests the effort `low`. */
const lowRoutes = [
  { route: "reasoningEffort", options: { reasoningEffort: "low" } },
  { route: "configOverrides", options: { configOverrides: ["model_reasoning_effort=low"] } },
] as const;

test.each(
  lowRoutes,
)("C-API-28 holds ready for the effort requested via $route until Codex shows it", async ({
  options,
}) => {
  const { session, warnings, activities, queued, pty } = await deadlineOnDefaultFooter(options);
  try {
    // Past the deadline, the footer waiting for the effort is Codex's own startup screen.
    expect(session.status).not.toBe("blocked");
    expect(activities.some(({ kind }) => kind === "unrecognized_startup")).toBe(false);
    expect(pty.writes).not.toContain(paste);
    pty.emitData(paint(effortLow));
    await vi.advanceTimersByTimeAsync(500);
    await queued;
    expect(pty.writes).toContain(paste);
    expect(warnings).toEqual([]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test.each<{ readonly label: string; readonly options: Partial<StartCodexOptions> }>([
  { label: "no effort", options: {} },
  {
    label: "reasoningEffort none over a configOverrides effort",
    options: { reasoningEffort: "none", configOverrides: ["model_reasoning_effort=low"] },
  },
  {
    // Codex 0.172 ignores this key even with the profile selected (docs/cli-behavior.md).
    label: "only the selected profile's effort in configOverrides",
    options: { profile: "fast", configOverrides: ['profiles.fast.model_reasoning_effort="low"'] },
  },
])("C-API-28 with $label the deadline marks ready on the default footer", async ({ options }) => {
  const { session, warnings, queued, pty } = await deadlineOnDefaultFooter(options);
  try {
    await queued;
    expect(pty.writes).toContain(paste);
    expect(warnings).toEqual([]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test.each([
  // Codex reads this basic string's escape as `low`; Elwood does not read escapes.
  'model_reasoning_effort="lo\\u0077"',
  // Codex launches with an effort it does not know and fails at the first turn.
  'model_reasoning_effort="extreme"',
])("C-API-28 an effort Elwood does not recognize in %s holds no wait and warns once", async (override) => {
  const { session, warnings, queued, pty } = await deadlineOnDefaultFooter({
    configOverrides: ['model_reasoning_effort="high"', override],
  });
  try {
    await queued;
    expect(pty.writes).toContain(paste);
    expect(warnings).toEqual([
      {
        elwoodSessionId: session.elwoodSessionId,
        agent: "codex",
        source: "lifecycle",
        code: "codex_effort_unrecognized",
        severity: "warning",
        message:
          "Elwood did not recognize the reasoning effort that the last model_reasoning_effort entry in configOverrides sets. Codex receives it unchanged, but readiness does not wait for Codex to apply it, so a mode or model picked before then can be discarded.",
        raw: "codex_effort_unrecognized",
      },
    ]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test.each([
  // The deadline, 10 s after the frame, has passed by 50 s after launch.
  { firstFrameAfterMs: 20_000, heldAtMs: 45_000, readyAtMs: 50_500 },
  // A frame after 40 s: the wait ends with the deadline, 10 s after it, not at 50 s.
  { firstFrameAfterMs: 45_000, heldAtMs: 50_500, readyAtMs: 55_500 },
])("C-API-28 a host's default wait sees ready when the label never comes, first frame at $firstFrameAfterMs ms", async ({
  firstFrameAfterMs,
  heldAtMs,
  readyAtMs,
}) => {
  const { session, warnings, activities, queued, waited, pty } = await deadlineOnDefaultFooter(
    { reasoningEffort: "low" },
    { firstFrameAfterMs, afterFrameMs: heldAtMs - firstFrameAfterMs },
  );
  try {
    expect(session.status).not.toBe("ready");
    expect(pty.writes).not.toContain(paste);
    expect(warnings).toEqual([]);
    // With no repaint, and before the host's 60 s default expires.
    await vi.advanceTimersByTimeAsync(readyAtMs - heldAtMs);
    expect(pty.writes).toContain(paste);
    expect(await waited).toBe("ready");
    await queued;
    const warning = {
      elwoodSessionId: session.elwoodSessionId,
      agent: "codex",
      source: "lifecycle",
      code: "codex_effort_unconfirmed",
      severity: "warning",
      message:
        "Codex did not show the requested reasoning effort within 50 seconds of launch; readiness was released on its status footer, and a mode or model picked before Codex applies its configuration can be discarded.",
      raw: "codex_effort_unconfirmed",
    } as const;
    expect(warnings).toEqual([warning]);
    const projected = activities.filter(({ kind }) => kind === "warning");
    expect(projected).toEqual([
      {
        elwoodSessionId: session.elwoodSessionId,
        agent: "codex",
        source: "lifecycle",
        kind: "warning",
        label: warning.code,
        text: warning.message,
        raw: warning,
      },
    ]);
    expect(activities.some(({ kind }) => kind === "unrecognized_startup")).toBe(false);
    expect(session.terminal.snapshot().text).toContain(sentinel);
    expect(JSON.stringify([warnings, projected])).not.toContain(sentinel);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});

test.each(lowRoutes)("C-API-28 a resume waits for the effort requested via $route", async ({
  options,
}) => {
  const cwd = tempDir();
  installFakes();
  const first = await startCodex({ cwd });
  await becomeReady(first.elwoodSessionId, cwd);
  await first.stop();
  const elwoodSessionId = first.elwoodSessionId;
  const resumed = await resumeCodex({ cwd, elwoodSessionId, initialSize, ...options });
  const queued = resumed.sendMessage("after configuration");
  void queued.catch(() => undefined);
  const render = async (frame: string) => {
    ptys[1]!.emitData(paint(frame));
    await resumed.terminal.settled();
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    await render(effortDefault);
    expect(resumed.status).not.toBe("ready");
    expect(ptys[1]!.writes).not.toContain(paste);
    await render(effortLow);
    await queued;
    expect(ptys[1]!.writes).toContain(paste);
  } finally {
    await resumed.teardown();
  }
});

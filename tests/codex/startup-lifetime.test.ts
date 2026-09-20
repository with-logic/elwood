/** Real session disposal cancels pending startup writes and diagnostics (C-CODEX-12). */
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import * as startupFrame from "../../src/core/startup/frame.ts";
import { startCodex } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import * as terminal from "../../src/terminal/headless.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const prompt = "Update available! 0.153.3 -> 0.153.4\r\n› 1. Update now\r\n  2. Skip";
afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  "stop",
  "kill",
  "exit",
] as const)("C-CODEX-12 %s cancels a real session write suspended on render settlement", async (method) => {
  installFakes();
  const attach = terminal.attachPtyTerminal;
  let startupTerminal!: terminal.ElwoodTerminal;
  vi.spyOn(terminal, "attachPtyTerminal").mockImplementation((...args) => {
    startupTerminal = attach(...args);
    return startupTerminal;
  });
  const session = await startCodex({ cwd: tempDir() });
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settle = vi.spyOn(startupTerminal, "settled").mockReturnValue(pending);
  const send = vi.spyOn(startupTerminal, "sendInput");
  const events: string[] = [];
  session.on("warning", (event) => events.push(event.code));
  session.on("activity", (event) => events.push(event.kind));
  let shutdown: Promise<void> | undefined;
  try {
    ptys[0]!.emitData(prompt);
    await vi.waitFor(() => expect(settle).toHaveBeenCalled());
    if (method === "exit") ptys[0]!.emitExit({ exitCode: 0 });
    else shutdown = session[method]();
    await vi.waitFor(() => expect(["stopped", "killed", "exited"]).toContain(session.status));
    release();
    await shutdown;
    await setImmediate();
    expect(send).not.toHaveBeenCalled();
    expect(ptys[0]!.writes).toEqual([]);
    expect(events).not.toContain("startup_prompt");
    expect(events).not.toContain("startup_prompt_write_failed");
  } finally {
    release();
    await shutdown?.catch(() => undefined);
    await session.teardown();
  }
});

test("C-CODEX-12 disposal drops a write-failure warning while startup delivery is held", async () => {
  installFakes();
  setCommandRunnerForTests(() => ({ status: 0, stdout: "unknown build", stderr: "" }));
  let flush = () => {};
  const buffered: string[] = [];
  const createGate = startupFrame.createStartupWarningGate;
  vi.spyOn(startupFrame, "createStartupWarningGate").mockImplementation((sink) => {
    const gate = createGate(sink);
    flush = gate.openAfterReturn;
    return {
      ...gate,
      emitWarnings: (warnings) => {
        buffered.push(...warnings.map((warning) => warning.code));
        gate.emitWarnings(warnings);
      },
      openAfterReturn: () => {},
    };
  });
  const session = await startCodex({ cwd: tempDir() });
  const warnings: string[] = [];
  session.on("warning", (event) => warnings.push(event.code));
  try {
    // Emit only after the adapter has registered its actual PTY output observer.
    // The gate remains closed, isolating buffered delivery from startup timing.
    ptys[0]!.failOnWrite = "2";
    ptys[0]!.emitData(prompt);
    await vi.waitFor(() => expect(buffered).toContain("startup_prompt_write_failed"));
    await session.stop();
    flush();
    await vi.waitFor(() => expect(warnings).toContain("version_unparseable"));
    expect(warnings).not.toContain("startup_prompt_write_failed");
  } finally {
    await session.teardown();
  }
});

test("C-CODEX-12 reentrant stop suppresses later update failures but preserves trust diagnostics", async () => {
  installFakes();
  let deliver: startupFrame.FrameWarningSink["emitWarnings"] = () => {};
  const createGate = startupFrame.createStartupWarningGate;
  vi.spyOn(startupFrame, "createStartupWarningGate").mockImplementation((sink) => {
    deliver = sink.emitWarnings;
    return createGate(sink);
  });
  const session = await startCodex({ cwd: tempDir() });
  const warnings: string[] = [];
  const activities: string[] = [];
  let stopping: Promise<void> | undefined;
  session.on("warning", (event) => {
    warnings.push(event.code === "startup_prompt_write_failed" ? event.label : event.code);
    stopping ??= session.stop();
  });
  session.on("activity", (event) => {
    if (event.kind === "warning") activities.push(event.label);
  });
  const failure = {
    elwoodSessionId: session.elwoodSessionId,
    agent: "codex",
    source: "terminal",
    code: "startup_prompt_write_failed",
    severity: "warning",
    message: "Write rejected",
    raw: "write rejected",
  } as const;
  try {
    deliver([
      { ...failure, label: "workspace_trust" },
      { ...failure, label: "update" },
      { ...failure, label: "workspace_trust" },
    ]);
    await stopping;
    expect(warnings).toEqual(["workspace_trust", "workspace_trust"]);
    expect(activities).toHaveLength(2);
  } finally {
    await session.teardown();
  }
});

test("C-CODEX-17 live update write failure delivers warning and projected activity", async () => {
  installFakes();
  const session = await startCodex({ cwd: tempDir() });
  const warnings: unknown[] = [];
  const activities: unknown[] = [];
  session.on("warning", (event) => warnings.push(event));
  session.on("activity", (event) => {
    if (event.kind === "warning") activities.push(event);
  });
  ptys[0]!.failOnWrite = "2";
  try {
    ptys[0]!.emitData(prompt);
    await vi.waitFor(() =>
      expect(warnings).toEqual([
        expect.objectContaining({
          code: "startup_prompt_write_failed",
          label: "update",
        }),
      ]),
    );
    expect(activities).toEqual([
      expect.objectContaining({
        kind: "warning",
        label: "startup_prompt_write_failed",
        raw: warnings[0],
      }),
    ]);
  } finally {
    await session.teardown();
  }
});

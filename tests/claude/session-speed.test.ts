/** End-to-end launch-boundary coverage for typed speed and resume overrides. C-SPEED-01. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeSession, resumeClaude, startClaude, startOrResumeClaude } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";
import { readSessionRecord, sessionDir, writeSessionRecord } from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  false,
  true,
] as const)("C-SPEED-01 claude applies %s on start, resume, lazy and helper paths without persisting speed", async (value) => {
  installFakes();
  const cwd = tempDir();
  const stateDir = join(cwd, ".elwood");
  const overrides = { settingsOverrides: { fastMode: !value, testOverride: "retained" } };
  const options = { cwd, stateDir, fastMode: value, ...overrides };
  const settingsText = () =>
    readFileSync(/--settings '([^']+)'/.exec(ptys.at(-1)!.options.args.join(" "))![1]!, "utf8");
  const check = () => {
    const settings = JSON.parse(settingsText());
    expect(settings).toMatchObject({
      fastMode: value,
      testOverride: "retained",
      hooks: expect.any(Object),
    });
  };
  const started = await startClaude(options);
  const id = started.elwoodSessionId;
  check();
  await started.stop();
  const record = readSessionRecord(stateDir, id);
  writeSessionRecord(
    { ...record, claude: { ...record.claude, resumeId: "native-speed" } },
    sessionDir(stateDir, id),
  );
  const resumed = await resumeClaude({ ...options, elwoodSessionId: id });
  expect(resumed.elwoodSessionId).toBe(id);
  check();
  await resumed.stop();
  const helper = await startOrResumeClaude({ ...options, elwoodSessionId: id });
  expect(helper.resumed).toBe(true);
  check();
  await helper.session.stop();
  expect(JSON.stringify(readSessionRecord(stateDir, id))).not.toContain("fastMode");
  const inherited = await resumeClaude({ cwd, stateDir, elwoodSessionId: id });
  expect(settingsText()).not.toContain("fastMode");
  await inherited.stop();
  const priorLaunches = ptys.length;
  const lazy = new ClaudeSession(options);
  expect(ptys).toHaveLength(priorLaunches);
  await lazy.start();
  check();
  await lazy.stop();
  const freshHelper = await startOrResumeClaude(options);
  expect(freshHelper.resumed).toBe(false);
  check();
  await freshHelper.session.stop();
});

test.each([
  "ultrafast",
  "true",
  1,
  null,
])("C-SPEED-01 claude refuses invalid %s before preflight or state setup", async (value) => {
  installFakes();
  const cwd = tempDir();
  const stateDir = join(cwd, ".elwood");
  const probe = vi.fn(() => ({ status: 0, stdout: "2.1.144\n", stderr: "" }));
  setCommandRunnerForTests(probe);
  await expect(startClaude({ cwd, stateDir, fastMode: value as never })).rejects.toMatchObject({
    code: "invalid_speed",
    details: { agent: "claude", option: "fastMode", valid: [true, false] },
    message: expect.stringContaining("must be one of:"),
  });
  expect(ptys).toHaveLength(0);
  expect.soft(probe).not.toHaveBeenCalled();
  expect.soft(existsSync(stateDir)).toBe(false);
});

test("C-SPEED-01 invalid claude resume cannot reserve ownership ahead of cleanup", async () => {
  installFakes();
  const cwd = tempDir();
  const stateDir = join(cwd, ".elwood");
  const session = await startClaude({ cwd, stateDir });
  await session.stop();
  const id = session.elwoodSessionId;
  const directory = sessionDir(stateDir, id);
  const record = readSessionRecord(stateDir, id);
  writeSessionRecord(
    { ...record, claude: { ...record.claude, resumeId: "native-speed" } },
    directory,
  );
  const cleanup = reserveLaunchOwnership(directory);
  try {
    const resumed = resumeClaude({ stateDir, elwoodSessionId: id, fastMode: "ultrafast" as never });
    const rejected = expect(resumed).rejects.toMatchObject({ code: "invalid_speed" });
    const retainedOwnership = cleanup.current();
    await rejected;
    expect(retainedOwnership).toBe(true);
    expect(ptys).toHaveLength(1);
  } finally {
    cleanup.rollback();
  }
});

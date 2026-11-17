/** End-to-end launch-boundary coverage for typed speed and resume overrides. C-SPEED-01. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resumeClaude, startClaude, startOrResumeClaude } from "../../src/index.ts";
import { reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";
import { readSessionRecord, sessionDir, writeSessionRecord } from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  false,
  true,
] as const)("C-SPEED-01 claude applies %s on start, resume and helper without persisting speed", async (value) => {
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
});

test.each([
  "ultrafast",
  "true",
  1,
  null,
])("C-SPEED-01 claude refuses invalid %s before PTY spawn", async (value) => {
  installFakes();
  await expect(startClaude({ cwd: tempDir(), fastMode: value as never })).rejects.toMatchObject({
    code: "invalid_speed",
    details: { agent: "claude", option: "fastMode", valid: [true, false] },
    message: expect.stringContaining("must be one of:"),
  });
  expect(ptys).toHaveLength(0);
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

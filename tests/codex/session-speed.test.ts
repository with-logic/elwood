/** End-to-end launch-boundary coverage for typed speed and resume overrides. C-SPEED-01. */
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resumeCodex, startCodex, startOrResumeCodex } from "../../src/index.ts";
import { reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";
import { readSessionRecord, sessionDir, writeSessionRecord } from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  "default",
  "fast",
  "ultrafast",
] as const)("C-SPEED-01 codex applies %s on start, resume and helper without persisting speed", async (value) => {
  installFakes();
  const cwd = tempDir();
  const stateDir = join(cwd, ".elwood");
  const overrides = { configOverrides: ['service_tier="other"', "test_override=true"] };
  const options = { cwd, stateDir, serviceTier: value, ...overrides };
  const check = () => {
    const command = ptys.at(-1)!.options.args.join(" ");
    expect(command).toContain("test_override=true");
    expect(command.indexOf(`service_tier="${value}"`)).toBeGreaterThan(
      command.indexOf('service_tier="other"'),
    );
  };
  const started = await startCodex(options);
  const id = started.elwoodSessionId;
  check();
  await started.stop();
  const record = readSessionRecord(stateDir, id);
  writeSessionRecord(
    { ...record, codex: { ...record.codex, resumeId: "native-speed" } },
    sessionDir(stateDir, id),
  );
  const resumed = await resumeCodex({ ...options, elwoodSessionId: id });
  expect(resumed.elwoodSessionId).toBe(id);
  check();
  await resumed.stop();
  const helper = await startOrResumeCodex({ ...options, elwoodSessionId: id });
  expect(helper.resumed).toBe(true);
  check();
  await helper.session.stop();
  expect(JSON.stringify(readSessionRecord(stateDir, id))).not.toContain("serviceTier");
  const inherited = await resumeCodex({ cwd, stateDir, elwoodSessionId: id });
  expect(ptys.at(-1)!.options.args.join(" ")).not.toContain("service_tier");
  await inherited.stop();
});

test.each([
  "priority",
  "bogus",
  true,
  null,
])("C-SPEED-01 codex refuses invalid %s before PTY spawn", async (value) => {
  installFakes();
  await expect(startCodex({ cwd: tempDir(), serviceTier: value as never })).rejects.toMatchObject({
    code: "invalid_speed",
    details: { agent: "codex", option: "serviceTier", valid: ["default", "fast", "ultrafast"] },
    message: expect.stringContaining("must be one of:"),
  });
  expect(ptys).toHaveLength(0);
});

test("C-SPEED-01 invalid codex resume cannot reserve ownership ahead of cleanup", async () => {
  installFakes();
  const cwd = tempDir();
  const stateDir = join(cwd, ".elwood");
  const session = await startCodex({ cwd, stateDir });
  await session.stop();
  const id = session.elwoodSessionId;
  const directory = sessionDir(stateDir, id);
  const record = readSessionRecord(stateDir, id);
  writeSessionRecord(
    { ...record, codex: { ...record.codex, resumeId: "native-speed" } },
    directory,
  );
  const cleanup = reserveLaunchOwnership(directory);
  try {
    const resumed = resumeCodex({ stateDir, elwoodSessionId: id, serviceTier: "bogus" as never });
    const rejected = expect(resumed).rejects.toMatchObject({ code: "invalid_speed" });
    const retainedOwnership = cleanup.current();
    await rejected;
    expect(retainedOwnership).toBe(true);
    expect(ptys).toHaveLength(1);
  } finally {
    cleanup.rollback();
  }
});

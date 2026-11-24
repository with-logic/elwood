/** Optional Codex resume metadata failures remain visible and content-free (C-STATE-15). */
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type ElwoodWarningEvent, resumeCodex, startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const nativeSessionId = "native-resume-diagnostic";
const unavailable = "codex_rollout_locator_unavailable";

async function saveRollout() {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "native-rollout.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId } })}\n`,
  );
  const initial = await startCodex({ cwd });
  try {
    await becomeReady(initial.elwoodSessionId, cwd, {
      session_id: nativeSessionId,
      transcript_path: path,
    });
  } finally {
    await initial.stop();
  }
  const { elwoodSessionId } = initial;
  const locator = join(cwd, ".elwood", "sessions", elwoodSessionId, "codex-rollout.json");
  return { resume: { cwd, elwoodSessionId }, path, locator };
}

test.each([
  "locator",
  "rollout",
] as const)("C-STATE-15 an unusable %s yields a single content-free resume warning", async (source) => {
  const { resume, path, locator } = await saveRollout();
  writeFileSync(source === "locator" ? locator : path, "malformed native or private data\n");
  const session = await resumeCodex(resume);
  const warnings: ElwoodWarningEvent[] = [];
  const activities: string[] = [];
  session.on("warning", (warning) => warnings.push(warning));
  session.on("activity", (event) => {
    if (event.kind === "warning") activities.push(event.label);
  });
  try {
    await expect.poll(() => warnings.map(({ code }) => code)).toEqual([unavailable]);
    expect(activities).toEqual([unavailable]);
    expect(warnings[0]).toEqual({
      elwoodSessionId: resume.elwoodSessionId,
      agent: "codex",
      source: "lifecycle",
      code: unavailable,
      severity: "warning",
      message: "Elwood could not verify the saved Codex transcript location.",
      raw: unavailable,
    });
  } finally {
    await session.teardown();
  }
});

test("C-STATE-15 a session without a saved locator resumes without a diagnostic", async () => {
  const { resume, locator } = await saveRollout();
  unlinkSync(locator);
  const session = await resumeCodex(resume);
  const warnings: string[] = [];
  session.on("warning", ({ code }) => warnings.push(code));
  await session.teardown();
  expect(warnings).toEqual([]);
});

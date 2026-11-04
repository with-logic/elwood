/** Native macOS rollback reaches the original files after a parent rename (C-API-61). */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startClaudeWithId } from "../../src/claude/session/index.ts";
import { resumeClaude, resumeCodex } from "../../src/index.ts";
import { setCommandRunnerForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { writePrivateFileAtomic } from "../../src/state/files.ts";
import { LaunchPublication } from "../../src/state/launch-publication.ts";
import {
  createSessionRecord,
  prepareStateDir,
  updateSessionResumeId,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { installFakes, resetFakes, tempDir } from "../claude/helpers.ts";

afterEach(resetFakes);

describe.runIf(process.platform === "darwin")("native moved-directory rollback", () => {
  test("C-API-61 moved publication restores physical existing record and removes fresh record", () => {
    const root = tempDir();
    const cwd = join(root, "workspace");
    const moved = join(root, "moved");
    mkdirSync(cwd);
    const file = join(cwd, "session.json");
    const fresh = join(cwd, "fresh.json");
    writePrivateFileAtomic(file, "prior posture");
    const publication = new LaunchPublication();
    publication.write(file, "attempted posture");
    publication.write(fresh, "orphan start");
    renameSync(cwd, moved);
    mkdirSync(cwd);
    publication.rollback();
    expect(readFileSync(join(moved, "session.json"), "utf8")).toBe("prior posture");
    expect(existsSync(join(moved, "fresh.json"))).toBe(false);
  });

  test.each([
    "claude",
    "codex",
  ] as const)("C-API-61 public failed %s resume restores saved posture in the moved workspace", async (agent) => {
    installFakes();
    setCommandRunnerForTests(() => ({
      status: 0,
      stdout: "2.1.144 (Claude Code) codex-cli 0.150.0",
      stderr: "",
    }));
    const root = tempDir();
    const cwd = join(root, "workspace");
    const moved = join(root, "moved");
    mkdirSync(cwd);
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir, { cwd });
    const dir = join(stateDir, "sessions", "resume-moved");
    mkdirSync(dir, { mode: 0o700 });
    const record = updateSessionResumeId(
      createSessionRecord({ cwd, id: "resume-moved", adapter: agent }),
      agent,
      "old-resume",
    );
    writeSessionRecord(record, dir);
    const before = readFileSync(join(dir, "session.json"), "utf8");
    setPtyFactoryForTests(() => {
      renameSync(cwd, moved);
      mkdirSync(cwd);
      throw new Error("child refused replaced directory");
    });
    await expect(
      agent === "claude"
        ? resumeClaude({ stateDir, elwoodSessionId: "resume-moved", permissionMode: "plan" })
        : resumeCodex({ stateDir, elwoodSessionId: "resume-moved", sandbox: "danger-full-access" }),
    ).rejects.toMatchObject({ code: `${agent}_start_failed` });
    expect(
      readFileSync(join(moved, ".elwood", "sessions", "resume-moved", "session.json"), "utf8"),
    ).toBe(before);
  });

  test("C-API-61 failed start removes published files in the moved workspace", async () => {
    installFakes();
    const root = tempDir();
    const cwd = join(root, "workspace");
    const moved = join(root, "moved");
    mkdirSync(cwd);
    setPtyFactoryForTests(() => {
      renameSync(cwd, moved);
      mkdirSync(cwd);
      throw new Error("child refused replaced directory");
    });
    await expect(startClaudeWithId({ cwd }, "start-moved")).rejects.toMatchObject({
      code: "claude_start_failed",
    });
    expect(readdirSync(join(moved, ".elwood", "sessions", "start-moved"))).toEqual([]);
  });
});

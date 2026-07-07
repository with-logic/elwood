/**
 * Conformance tests for persisted launch posture and resume defaulting.
 * Covers PRD §5.2, §5.6, §8.2, C-STATE-13, and C-API-32.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { effectivePosture } from "../../src/state/launch-posture.ts";
import {
  createSessionRecord,
  prepareStateDir,
  sessionDir,
  updateSessionResumeId,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "../claude/helpers.ts";

afterEach(resetFakes);

function readRecord(stateDir: string, id: string): Record<string, { launch?: unknown }> {
  return JSON.parse(readFileSync(join(sessionDir(stateDir, id), "session.json"), "utf8"));
}

function resumableRecord(cwd: string, stateDir: string, id: string) {
  prepareStateDir(stateDir);
  const record = updateSessionResumeId(
    createSessionRecord({ stateDir, cwd, id }),
    "claude",
    "claude-native",
  );
  return record;
}

describe("launch posture persistence", () => {
  test("C-STATE-13 start persists the resolved launch posture", async () => {
    const cwd = tempDir();
    const stateDir = join(tempDir(), "state");
    installFakes();
    const session = await startClaude({
      cwd,
      stateDir,
      permissionMode: "bypassPermissions",
      tools: ["Read", "Edit"],
      disallowedTools: ["WebSearch"],
    });
    expect(readRecord(stateDir, session.elwoodSessionId)["claude"]?.launch).toEqual({
      permissionMode: "bypassPermissions",
      disallowedTools: ["WebSearch"],
      tools: ["Read", "Edit"],
    });
  });

  test("C-API-32 a bare resume relaunches with the persisted posture", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, ".elwood");
    const record = resumableRecord(cwd, stateDir, "posture-bare");
    writeSessionRecord({
      ...record,
      claude: {
        ...record.claude,
        launch: { permissionMode: "bypassPermissions", tools: ["Read"] },
      },
    });
    installFakes();
    await resumeClaude({ cwd, elwoodSessionId: "posture-bare" });
    const args = ptys[0]!.options.args.join(" ");
    expect(args).toContain("--permission-mode 'bypassPermissions'");
    expect(args).toContain("--tools 'Read'");
  });

  test("C-API-32 explicit options override and the effective posture re-persists", async () => {
    const cwd = tempDir();
    const stateDir = join(cwd, ".elwood");
    const record = resumableRecord(cwd, stateDir, "posture-override");
    writeSessionRecord({
      ...record,
      claude: {
        ...record.claude,
        launch: { permissionMode: "bypassPermissions", tools: ["Read"] },
      },
    });
    installFakes();
    await resumeClaude({ cwd, elwoodSessionId: "posture-override", permissionMode: "plan" });
    const args = ptys[0]!.options.args.join(" ");
    expect(args).toContain("--permission-mode 'plan'");
    expect(args).toContain("--tools 'Read'");
    expect(readRecord(stateDir, "posture-override")["claude"]?.launch).toEqual({
      permissionMode: "plan",
      tools: ["Read"],
    });
  });

  test("C-API-32 effectivePosture drops fully-empty results", () => {
    expect(effectivePosture(undefined, undefined)).toBeUndefined();
    expect(effectivePosture({ sandbox: "read-only" }, { sandbox: "workspace-write" })).toEqual({
      sandbox: "workspace-write",
    });
  });
});

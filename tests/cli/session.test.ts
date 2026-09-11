/**
 * CLI facade ordering and exact-resume coverage (PRD §12A.2, C-CLI-03/C-CLI-08).
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { finalizeRunRequest } from "../../src/cli/request/index.ts";
import {
  type CliSessionDependencies,
  HeadlessCliSession,
  prepareCliSession,
} from "../../src/cli/session/index.ts";
import type { CliAgent, EffectiveRunRequest, ResolvedRunRequest } from "../../src/cli/types.ts";
import { readPrivateSessionRecord } from "../../src/state/private-session.ts";
import {
  createSessionRecord,
  prepareStateDir,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { FakeUnderlying } from "../unit/simple-fakes.ts";
import { effectiveRequest } from "./main-fakes.ts";

afterEach(() => vi.useRealTimers());

function effective(
  root: string,
  overrides: Partial<EffectiveRunRequest> = {},
): EffectiveRunRequest {
  return effectiveRequest({
    stateDir: join(root, "state"),
    cwd: root,
    prompt: "user",
    ...overrides,
  });
}

function draft(root: string, resume?: string): ResolvedRunRequest {
  return {
    ...effective(root),
    agentOptions: {
      claude: { model: "claude-model", reasoningEffort: "high" },
      codex: { model: "codex-model", reasoningEffort: "minimal" },
    },
    imagePaths: [],
    ...(resume === undefined ? {} : { resume, cwd: undefined }),
  } as ResolvedRunRequest;
}

function dependencies(id = "new-id"): CliSessionDependencies {
  const unavailable = (): Promise<never> => Promise.reject(new Error("not launched"));
  return {
    randomId: () => id,
    readRecord: readPrivateSessionRecord,
    finalize: finalizeRunRequest,
    launch: {
      prepareStateRoot: () => undefined,
      startClaude: unavailable,
      resumeClaude: unavailable,
      startCodex: unavailable,
      resumeCodex: unavailable,
    },
  };
}

describe("headless CLI session", () => {
  test("C-CLI-16 prepares a new session with a preallocated identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-session-"));
    const prepared = await prepareCliSession(draft(root), dependencies("allocated"));
    expect(prepared.request).toMatchObject({ agent: "codex", cwd: root });
    expect(prepared.session).toMatchObject({ id: "allocated", resumed: false });
  });

  test("C-CLI-16 default preparation allocates without eagerly launching", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-session-"));
    const prepared = await prepareCliSession(draft(root));
    expect(prepared.session.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(prepared.session.session).toBeUndefined();
  });

  test("C-CLI-08 persona is one discarded setup turn and setup is single-flight", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-session-"));
    const live = new FakeUnderlying();
    const session = new HeadlessCliSession(
      effective(root, { persona: "be concise" }),
      "s1",
      async () => live,
    );
    const first = session.setup();
    const second = session.setup();
    await vi.advanceTimersByTimeAsync(2_001);
    await Promise.all([first, second]);
    expect(live.sends).toBe(1);
    expect(live.args["sendMessage"]?.[0]).toBe("be concise");
  });

  test("C-CLI-08 resume switches model before user work and never applies persona", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-session-"));
    const live = new FakeUnderlying();
    const session = new HeadlessCliSession(
      effective(root, { resume: "s1", model: "next", persona: "ignored" }),
      "s1",
      async () => live,
    );
    await session.setup();
    expect(live.calls).toEqual(["setModel"]);
    expect(live.sends).toBe(0);
  });

  test("C-CLI-08/C-CLI-09 cleanup owns live, rejected, and mismatched launches", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-session-"));
    const live = new FakeUnderlying();
    const owned = new HeadlessCliSession(effective(root), "s1", async () => live);
    const statuses: string[] = [];
    owned.on("status", ({ status }) => statuses.push(status));
    await owned.start();
    live.emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    await owned.teardown();
    expect(statuses).toEqual(["ready"]);
    expect(live.calls).toContain("teardown");

    const bad = new FakeUnderlying();
    const failedKill = vi.spyOn(bad, "kill").mockRejectedValue(new Error("kill failed"));
    const mismatch = new HeadlessCliSession(effective(root), "different", async () => bad);
    await expect(mismatch.start()).rejects.toMatchObject({ code: "state_corrupt" });
    expect(failedKill).toHaveBeenCalledOnce();

    const stateDir = join(root, "state");
    prepareStateDir(stateDir);
    writeSessionRecord(
      createSessionRecord({ cwd: root, id: "failed", adapter: "codex" }),
      sessionDir(stateDir, "failed"),
    );
    const failed = new HeadlessCliSession(effective(root), "failed", () =>
      Promise.reject(new Error("start failed")),
    );
    await expect(failed.start()).rejects.toThrow(/start failed/iu);
    await failed.teardown();
    expect(existsSync(sessionDir(stateDir, "failed"))).toBe(false);
  });

  test("C-CLI-03 exact resume selects stored adapters and their config in both directions", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-session-"));
    const stateDir = join(root, "state");
    prepareStateDir(stateDir);
    for (const agent of ["claude", "codex"] as const) {
      const id = `${agent}-saved`;
      writeSessionRecord(
        createSessionRecord({ cwd: root, id, adapter: agent }),
        sessionDir(stateDir, id),
      );
      const configured: CliAgent = agent === "claude" ? "codex" : "claude";
      const prepared = await prepareCliSession(
        { ...draft(root, id), agent: configured },
        dependencies(),
      );
      expect(prepared.request).toMatchObject({ agent, cwd: root, model: `${agent}-model` });
      expect(prepared.session).toMatchObject({ agent, id, resumed: true });
    }
  });
});

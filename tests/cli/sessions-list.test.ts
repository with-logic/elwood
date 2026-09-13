/**
 * Session listing over a real private state directory.
 * Covers PRD §12A.8 and C-CLI-24.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { listCliSessions } from "../../src/cli/sessions/list.ts";
import { secureMkdir, writePrivateFile } from "../../src/state/files.ts";
import { ensureSocketHome, sessionSocketHome } from "../../src/state/socket-home.ts";
import { sessionDir } from "../../src/state/store.ts";
import { cleanupSessionFixtures, plant, roots, socketHomes, stateRoot } from "./sessions-fakes.ts";

afterEach(cleanupSessionFixtures);

describe("listCliSessions", () => {
  test("C-CLI-24 lists records most recently used first with timestamps, resumable, and live", () => {
    const stateDir = stateRoot();
    plant(stateDir, "older", "codex", { lastUsed: 1_700_000_000_000 });
    plant(stateDir, "oldest-b", "codex", { lastUsed: 1_600_000_000_000 });
    plant(stateDir, "oldest-a", "codex", { lastUsed: 1_600_000_000_000 });
    plant(stateDir, "newer", "claude", { resumeId: "conv-1", lastUsed: 1_800_000_000_000 });
    const home = sessionSocketHome({
      stateDir: resolve(stateDir),
      elwoodSessionId: "newer",
      adapter: "claude",
    });
    socketHomes.push(home);
    ensureSocketHome(home);
    writeFileSync(join(home, "ab12cd34.sock"), "");
    const result = listCliSessions(stateDir);
    expect(result.skipped).toEqual([]);
    expect(result.sessions.map((session) => session.id)).toEqual([
      "newer",
      "older",
      "oldest-a",
      "oldest-b",
    ]);
    expect(result.sessions[0]).toMatchObject({
      agent: "claude",
      cwd: resolve(tmpdir()),
      lastUsedAt: "2027-01-15T08:00:00.000Z",
      resumable: true,
      live: true,
    });
    expect(result.sessions[1]).toMatchObject({
      agent: "codex",
      lastUsedAt: "2023-11-14T22:13:20.000Z",
      resumable: false,
      live: false,
    });
    expect(Date.parse(result.sessions[0]?.createdAt ?? "")).toBeGreaterThan(0);
  });

  test("C-CLI-24 skips unreadable records and ignores non-directories", () => {
    const stateDir = stateRoot();
    plant(stateDir, "good", "codex");
    secureMkdir(sessionDir(stateDir, "broken"));
    writePrivateFile(join(sessionDir(stateDir, "broken"), "session.json"), "{not json");
    secureMkdir(sessionDir(stateDir, "empty"));
    writePrivateFile(join(stateDir, "sessions", "stray.txt"), "ignored");
    const result = listCliSessions(stateDir);
    expect(result.sessions.map((session) => session.id)).toEqual(["good"]);
    expect(result.skipped.map((entry) => entry.id).sort()).toEqual(["broken", "empty"]);
    expect(result.skipped.find((entry) => entry.id === "empty")?.message).toContain(
      "No Elwood session found",
    );
  });

  test("C-CLI-24 treats a missing sessions directory as empty and a corrupt one as an error", () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-sessions-missing-"));
    roots.push(root);
    expect(listCliSessions(join(root, "absent"))).toEqual({ sessions: [], skipped: [] });
    const corrupt = join(root, "corrupt");
    secureMkdir(corrupt);
    writePrivateFile(join(corrupt, "sessions"), "not a directory");
    expect(() => listCliSessions(corrupt)).toThrow("Could not read the Elwood state directory");
    const reader = () => {
      throw new Error("boom");
    };
    const stateDir = stateRoot();
    plant(stateDir, "one", "codex");
    expect(listCliSessions(stateDir, reader).skipped).toEqual([{ id: "one", message: "boom" }]);
  });
});

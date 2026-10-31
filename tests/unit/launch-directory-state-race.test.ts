/** Real starts undo only their own setup when cwd changes inside mkdir (C-API-61, C-STATE-14). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import { changeDirectory, project, useProbeProjects } from "../helpers/preflight-projects.ts";

const race = vi.hoisted(() => ({ path: "", run: () => {} }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (path: string, options?: fs.MakeDirectoryOptions) => {
      if (path === race.path) {
        race.path = "";
        race.run();
      }
      return actual.mkdirSync(path, options);
    },
  };
});
const launches = useProbeProjects();
afterEach(() => {
  race.path = "";
});

for (const [agent, version, start] of [
  ["claude", "2.1.144 (Claude Code)", startClaude],
  ["codex", "codex-cli 0.150.0", startCodex],
] as const) {
  for (const at of ["root", "sessions"] as const) {
    test(`C-API-61 C-STATE-14 ${agent} rolls back default scaffolding after replacement at ${at} mkdir`, async () => {
      const cwd = project(agent, version);
      const replacement = project(agent, version);
      const root = join(cwd, ".elwood");
      race.path = at === "root" ? root : join(root, "sessions");
      race.run = () => changeDirectory(cwd, replacement);
      await expect(start({ cwd })).rejects.toMatchObject({
        code: `${agent}_start_failed`,
        details: { cwd },
      });
      expect(fs.existsSync(root)).toBe(false);
      expect(launches).toEqual([]);
    });
  }
  for (const preserved of ["user files", "other session", "replacement ignore"] as const) {
    test(`C-STATE-14 ${agent} rollback preserves ${preserved}`, async () => {
      const cwd = project(agent, version);
      const replacement = project(agent, version);
      const root = join(cwd, ".elwood");
      const sessions = join(root, "sessions");
      // Swap after the ignore is created, then install unrelated contents at the new path.
      race.path = sessions;
      race.run = () => {
        changeDirectory(cwd, replacement);
        fs.mkdirSync(root);
        if (preserved === "other session")
          fs.mkdirSync(join(sessions, "other"), { recursive: true });
        else
          fs.writeFileSync(join(root, preserved === "user files" ? "notes" : ".gitignore"), "keep");
      };
      await expect(start({ cwd })).rejects.toMatchObject({ code: `${agent}_start_failed` });
      const kept =
        preserved === "other session"
          ? join(sessions, "other")
          : join(root, preserved === "user files" ? "notes" : ".gitignore");
      expect(fs.existsSync(kept)).toBe(true);
      if (preserved !== "other session") expect(fs.readFileSync(kept, "utf8")).toBe("keep");
      expect(launches).toEqual([]);
    });
  }
}

/** Session listings resolve only relevant defaults (PRD §12A.8, C-CLI-24). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import { resolveListingSettings } from "../../src/cli/sessions/settings.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function harness() {
  const root = mkdtempSync(join(tmpdir(), "listing-settings-"));
  roots.push(root);
  const config = join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      stateDir: "configured",
      output: "json",
      codex: { sandbox: "workspace-write" },
    }),
    { mode: 0o600 },
  );
  const context = {
    invocationCwd: root,
    homeDir: root,
    env: {
      ELWOOD_CONFIG: config,
      ELWOOD_CODEX_SANDBOX: "workspace-write",
      ELWOOD_CLAUDE_PERMISSION_MODE: "plan",
      ELWOOD_TRUST: "invalid",
      ELWOOD_PERSONA: "",
    },
  };
  const settings = (args: string[] = [], env = {}) => {
    const parsed = parseCliArgs(["sessions", ...args]);
    if (parsed.command !== "sessions") throw new Error("bad fixture");
    return resolveListingSettings(parsed.run, { ...context, env: { ...context.env, ...env } });
  };
  return { root, config, settings };
}
test("C-CLI-24 ignores conflicting adapter defaults and irrelevant environment values", () => {
  const h = harness();
  expect(h.settings()).toMatchObject({ stateDir: join(h.root, "configured"), output: "json" });
  expect(h.settings([], { ELWOOD_STATE_DIR: "environment", ELWOOD_OUTPUT: "text" })).toMatchObject({
    stateDir: join(h.root, "environment"),
    output: "text",
  });
  expect(
    h.settings(["--state-dir", "flag", "--output", "json"], {
      ELWOOD_STATE_DIR: "environment",
      ELWOOD_OUTPUT: "text",
    }),
  ).toMatchObject({ stateDir: join(h.root, "flag"), output: "json" });
  expect(h.settings(["--no-defaults"])).toMatchObject({
    stateDir: join(h.root, ".local/state/elwood"),
    output: "text",
  });
});
test("C-CLI-24 still rejects malformed config and consumed environment settings", () => {
  const h = harness();
  expect(() => h.settings([], { ELWOOD_OUTPUT: "bad" })).toThrow();
  expect(() => h.settings([], { ELWOOD_STATE_DIR: "" })).toThrow();
  writeFileSync(h.config, "{");
  expect(() => h.settings()).toThrow();
  expect(() => h.settings(["--no-defaults"])).not.toThrow();
  rmSync(h.config);
  mkdirSync(h.config);
  expect(() => h.settings()).toThrow();
});

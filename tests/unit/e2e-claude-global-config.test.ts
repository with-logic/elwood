/** The e2e suite's private Claude global config leaves out the user's history (PRD §12, C-E2E-23). */
import { expect, test } from "vitest";
import { parseGlobalConfig, privateGlobalConfig } from "../e2e/claude-global-config.ts";

test("C-E2E-23 the private Claude config keeps settings but not the user's history", () => {
  const user = {
    theme: "dark",
    hasCompletedOnboarding: false,
    projects: { "/work": { allowedTools: [] } },
    mcpServers: { docs: { command: "docs-mcp" } },
    bypassPermissionsModeAccepted: true,
    fullscreenBootPending: {
      "44923": { startedAt: 1, version: "2.1.332", host: "laptop", platform: "macos" },
    },
    fullscreenBootStrikes: { count: 1, version: "2.1.332" },
    fullscreenAutoDisabled: { version: "2.1.332", at: 1, strikes: 2 },
  };
  expect(JSON.parse(privateGlobalConfig(user))).toEqual({
    theme: "dark",
    hasCompletedOnboarding: true,
  });
  expect(JSON.parse(privateGlobalConfig({}))).toEqual({ hasCompletedOnboarding: true });
});

test("C-E2E-23 a global config parses only as a JSON object", () => {
  const path = "/private/config/.claude.json";
  expect(parseGlobalConfig('{"theme":"dark"}', path)).toEqual({ theme: "dark" });
  expect(() => parseGlobalConfig("{", path)).toThrow(`${path} is not JSON`);
  for (const text of ["[]", "null", '"dark"', "1"])
    expect(() => parseGlobalConfig(text, path)).toThrow(`${path} does not hold a JSON object`);
});

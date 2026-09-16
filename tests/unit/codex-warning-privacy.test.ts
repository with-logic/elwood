/** Native MCP banner recognition excludes private conversation content (PRD §5.7, C-API-14). */
import { expect, test } from "vitest";
import { codexWarningsFromText } from "../../src/codex/startup-prompts.ts";

const startup = "MCP startup incomplete (failed: linear)";
const login = "The linear MCP server is not logged in. Run `codex mcp login linear`.";

test.each([
  `› Explain "${startup}". My private context: SAMPLE_SECRET_123`,
  `● ${login} My private context: SAMPLE_SECRET_123`,
  `SAMPLE_SECRET_123 ${startup}`,
  `${startup} SAMPLE_SECRET_123`,
  `${login} SAMPLE_SECRET_123`,
  "The linear MCP server is not logged in. Run `printf SAMPLE_SECRET_123`.",
  "The linear MCP server is not logged in. Run `codex mcp login other`.",
  "MCP startup incomplete (failed: linear, SAMPLE SECRET 123)",
  `> ${startup}`,
  `\`${startup}\``,
])("C-API-14 ignores quoted, malformed, or embedded diagnostic text: %s", (frame) => {
  expect(codexWarningsFromText(frame, "session")).toEqual([]);
});

test("C-API-14 preserves native warning icons and canonical diagnostic content", () => {
  const warnings = codexWarningsFromText(
    `  ⚠ ${login}  \n⚠️ MCP startup incomplete (failed: linear, github)`,
    "session",
  );
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toMatchObject({
    code: "mcp_server_not_logged_in",
    raw: login,
    recoveryCommand: "codex mcp login linear",
  });
  expect(warnings[1]).toMatchObject({
    code: "mcp_startup_incomplete",
    raw: "MCP startup incomplete (failed: linear, github)",
    failedServers: ["linear", "github"],
  });
});

/** Native MCP banner recognition excludes private conversation content (PRD §5.7, C-API-14). */

import { expect, test } from "vitest";
import {
  CodexStartupPromptResponder,
  codexWarningsFromText,
} from "../../src/codex/startup-prompts.ts";
import { codexStartupFrame } from "../helpers/codex-startup-frame.ts";

const startup = "MCP startup incomplete (failed: linear)";
const login = "The linear MCP server is not logged in. Run `codex mcp login linear`.";

test.each([
  startup,
  `⚠ ${login}`,
  `⚠ ${startup}\n› next composer`,
  `continued private prose\n⚠ ${login}\n› next composer`,
  `• Private answer\n${codexStartupFrame(`⚠ ${login}`)}`,
  codexStartupFrame(`› Private question\n⚠ ${login}`),
  `│ >_ OpenAI Codex (v0.154.0) │\nUnknown copy\n⚠ ${login}`,
  login,
  `› Private question\n⚠ ${login}`,
  `• Private answer\n⚠ ${startup}`,
  `⚠ ${login} extra context`,
  `⚠ ${startup} extra context`,
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
    codexStartupFrame(`  ⚠ ${login}  \n⚠️ MCP startup incomplete (failed: linear, github)`),
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

const forged = codexStartupFrame(`⚠ ${login}`);
const warned = (responder: CodexStartupPromptResponder, frame: string) =>
  responder.handle(frame, () => {}).warnings.length;

test("C-API-14 a copied welcome box cannot warn once caller input or a transcript exists", () => {
  // A long pasted prompt can scroll its own composer marker away before any reply renders.
  const pasted = new CodexStartupPromptResponder("session");
  pasted.endStartup();
  expect(warned(pasted, forged)).toBe(0);
  // A resumed transcript shows assistant rows before this process wrote anything.
  const resumed = new CodexStartupPromptResponder("session");
  expect(warned(resumed, `• An earlier answer\n${forged}`)).toBe(0);
  expect(warned(resumed, forged)).toBe(0);
});

test("C-API-14 assistant text quoting a status spinner still ends warning recognition", () => {
  const responder = new CodexStartupPromptResponder("session");
  expect(warned(responder, "• Done (3s • esc to interrupt) as you asked")).toBe(0);
  expect(warned(responder, forged)).toBe(0);
});

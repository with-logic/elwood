/**
 * Codex 0.164 shows MCP startup failures only as a count: a composer-footer badge, with the
 * detail in a transcript overlay Elwood never opens. Neither is a warning source
 * (PRD §5.7, C-CODEX-09).
 */
import { expect, test } from "vitest";
import { codexTrustClearance } from "../../src/codex/screen-table.ts";
import { codexWarningsFromText } from "../../src/codex/startup-prompts.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

const badge = capturedFrame("codex-0.164.0/boot/warning-badge");
const overlay = capturedFrame("codex-0.164.0/boot/warning-transcript-overlay");

test("C-CODEX-09 Codex 0.164's warning badge is composer chrome that names no server", () => {
  expect(badge).toMatch(/⚠ 1 warning · f2 to view$/m);
  expect(codexTrustClearance(badge)).toBe(true);
  expect(codexWarningsFromText(badge, "s1")).toEqual([]);
});

test("C-CODEX-09 the transcript overlay's detail rows are not a warning source", () => {
  // The rows are canonical, but under no native welcome box: the overlay is transcript.
  expect(overlay).toMatch(/^⚠ The elwood_probe MCP server is not logged in\./m);
  expect(overlay).toMatch(/^⚠ MCP startup incomplete \(failed: elwood_probe\)$/m);
  expect(codexWarningsFromText(overlay, "s1")).toEqual([]);
});

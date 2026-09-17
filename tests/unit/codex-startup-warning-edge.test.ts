/**
 * Focused coverage for Codex startup-banner edge detection (C-API-14, §5.7).
 * A live warning is emitted ONCE when a banner is observed — not replayed every frame
 * off the accumulated buffer. Banners are keyed by a STABLE identity (code + named
 * server), so emulator reflow/padding is not a new occurrence, and a banner that clears
 * then reappears fires again as a genuinely new occurrence.
 */

import { describe, expect, test } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { codexStartupFrame } from "../helpers/codex-startup-frame.ts";

describe("C-API-14 Codex startup-banner edge detection", () => {
  test("a banner still on screen next frame is NOT re-emitted", () => {
    // A banner that stays on screen across consecutive frames must fire exactly once,
    // not replay every frame (§5.7) — the re-emit downstream dedup previously masked.
    const responder = new CodexStartupPromptResponder("s1");
    const banner = codexStartupFrame(
      "⚠ The linear MCP server is not logged in. Run `codex mcp login linear`.",
    );
    const first = responder.handle(banner, () => {});
    const second = responder.handle(`${banner}\nplus some later output`, () => {});
    expect(first.warnings.map((w) => w.code)).toEqual(["mcp_server_not_logged_in"]);
    expect(second.warnings).toEqual([]); // same banner still present → no re-emit
  });

  test("an unrelated follow-up frame does not replay a scrolled-off banner", () => {
    const responder = new CodexStartupPromptResponder("s1");
    responder.handle(codexStartupFrame("⚠ MCP startup incomplete (failed: linear)"), () => {});
    const next = responder.handle("just ordinary output, no banner here", () => {});
    expect(next.warnings).toEqual([]); // banner gone from the frame → nothing to re-emit
  });

  test("a banner that clears and reappears fires again (new occurrence)", () => {
    const responder = new CodexStartupPromptResponder("s1");
    const banner = codexStartupFrame(
      "⚠ The github MCP server is not logged in. Run `codex mcp login github`.",
    );
    const one = responder.handle(banner, () => {});
    responder.handle("cleared", () => {}); // banner leaves the frame
    const two = responder.handle(banner, () => {}); // the SAME banner reappears
    expect(one.warnings.map((w) => w.code)).toEqual(["mcp_server_not_logged_in"]);
    expect(two.warnings.map((w) => w.code)).toEqual(["mcp_server_not_logged_in"]);
  });

  test("the same banner re-rendered with different padding is not re-emitted", () => {
    // Banners are keyed by a stable identity (code + named server), not the raw
    // rendered line, so emulator reflow/padding across frames is not a new occurrence.
    const responder = new CodexStartupPromptResponder("s1");
    responder.handle(
      codexStartupFrame("⚠ The linear MCP server is not logged in. Run `codex mcp login linear`."),
      () => {},
    );
    const padded = responder.handle(
      codexStartupFrame(
        "   ⚠ The linear MCP server is not logged in. Run `codex mcp login linear`.   ",
      ),
      () => {},
    );
    expect(padded.warnings).toEqual([]);
  });
});

/** Complete user-history provenance preserves recovery without clearing menus (C-API-31/C-API-56). */
import { afterEach, expect, test } from "vitest";
import * as codex from "../../codex/helpers.ts";
import { codexSmallComposer } from "../../fixtures/trust-composer.ts";
import { composerFrame, withComposerSession } from "./session-fixture.ts";

afterEach(() => codex.resetFakes());
const wrap = "› Help me with\n  this codebase";
const histories: readonly {
  readonly name: string;
  readonly history: string;
  readonly allowed: boolean;
  readonly modelOnly?: boolean;
}[] = [
  { name: "complete wrapped user", history: `${wrap}\n\n• Prior reply`, allowed: true },
  {
    name: "unwrapped user",
    history: "› Help me with this codebase\n\n• Prior reply",
    allowed: true,
  },
  { name: "unfinished wrap", history: wrap, allowed: false },
  {
    name: "unfinished wrap without a startup prelude",
    history: wrap,
    allowed: false,
    modelOnly: true,
  },
  {
    name: "complete wrap without a startup prelude",
    history: `${wrap}\n\n• Prior reply`,
    allowed: true,
    modelOnly: true,
  },
  {
    name: "native choices before reply",
    history: "› 1. Trust and continue\n  2. Quit\n\n• Prior reply",
    allowed: false,
  },
  { name: "unknown boundary", history: `${wrap}\nUnknown dialog\n• Prior reply`, allowed: false },
  {
    name: "native option boundary",
    history: `${wrap}\n› 1. Trust and continue\n  2. Quit\n• Prior reply`,
    allowed: false,
  },
  {
    name: "working is not a reply",
    history: `${wrap}\n\n• Working (3s • esc to interrupt)`,
    allowed: false,
  },
  {
    name: "later menu",
    history: `${wrap}\n\n• Prior reply\n\n› Proceed\n  Cancel`,
    allowed: false,
  },
];

for (const payload of ["probe", ""]) {
  test.each(histories)(`C-API-31/C-API-56 ${payload || "empty"} input below $name`, async ({
    history,
    allowed,
    modelOnly,
  }) => {
    await withComposerSession({ autotrust: false }, async ({ emit, settle, clear }) => {
      // Native model-footer-only layout is valid without startup welcome/tip rows.
      const idle = modelOnly
        ? "› Ask Codex to do anything\n  gpt-5.3-codex high"
        : codexSmallComposer;
      emit(composerFrame(history, payload, idle), payload);
      await settle();
      expect(clear(payload)).toBe(allowed);
    });
  });
}

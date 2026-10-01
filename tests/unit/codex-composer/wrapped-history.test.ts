/** Complete user-history provenance preserves recovery without clearing menus (C-API-31/C-API-56). */
import { afterEach, expect, test } from "vitest";
import { codexEmptyInputFrame } from "../../../src/codex/screen/empty-input.ts";
import { codexInputStaged } from "../../../src/codex/screen/staged-input.ts";
import { startCodex } from "../../../src/index.ts";
import * as codex from "../../codex/helpers.ts";
import { codexSmallComposer, codexTty } from "../../fixtures/trust-composer.ts";

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
    codex.installFakes();
    const cwd = codex.tempDir();
    const session = await startCodex({
      cwd,
      initialSize: { cols: 200, rows: 32 },
      autotrust: false,
    });
    try {
      await codex.becomeReady(session.elwoodSessionId, cwd);
      // Native model-footer-only layout is valid without startup welcome/tip rows.
      const idle = modelOnly
        ? "› Ask Codex to do anything\n  gpt-5.3-codex high"
        : codexSmallComposer;
      const composer = payload ? idle.replace("› Ask Codex to do anything", `› ${payload}`) : idle;
      const frame = `${history}\n${composer}`;
      const row = frame.split("\n").findLastIndex((line) => line.startsWith("›"));
      // Prompt prefix occupies two columns; terminal coordinates are one-based.
      codex.ptys[0]!.emitData(
        `\u001b[2J\u001b[H${codexTty(frame)}\u001b[${row + 1};${payload.length + 3}H`,
      );
      await session.terminal.settled();
      expect(
        payload
          ? codexInputStaged(session.terminal, payload)
          : codexEmptyInputFrame(session.terminal) !== undefined,
      ).toBe(allowed);
    } finally {
      await session.teardown();
    }
  });
}

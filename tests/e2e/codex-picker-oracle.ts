/** Independent raw-key Codex catalog reading for native listing and switching (C-API-23/24). */
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Native oracle helpers own these assertions.
import assert from "node:assert/strict";
import type { AgentModelOption } from "../../src/index.ts";
import { waitFor } from "./wait-for.ts";

type PickerSession = {
  readonly terminal: { snapshot(): { readonly text: string } };
  sendKeys(input: string): Promise<void>;
};
type NativeRow = { readonly number: number; readonly label: string };
type NativeFrame = {
  readonly rows: readonly NativeRow[];
  readonly cursor: number;
  readonly below: boolean;
};

/** Checks the complete native order and chooses a row outside the opening window when possible. */
export async function nativeCodexTarget(
  session: PickerSession,
  models: readonly AgentModelOption[],
): Promise<AgentModelOption> {
  const native = await readCodexPicker(session);
  assert.deepEqual(
    models.map((model) => model.label),
    native.labels,
    "complete native picker order",
  );
  assert.ok(models.length >= 3, "picker lists several models");
  assert.equal(models.filter((model) => model.isCurrent).length, 1);
  const target =
    models.findLast(
      (model) => !(model.isCurrent || native.initiallyVisibleLabels.includes(model.label)),
    ) ??
    models.find((model) => model.id === "gpt-6.1-terra" && !model.isCurrent) ??
    models.findLast((model) => !model.isCurrent);
  assert.ok(target, "another native model is available");
  return target;
}

/**
 * Opens the same session's picker without production parsing, visits both numbered ends,
 * and records every displayed label in native order. The initial window identifies rows
 * that automated switching must reveal. Arrow moves never apply a model; Escape runs even
 * when reading or movement fails. One fixed deadline bounds the complete walk.
 */
export async function readCodexPicker(session: PickerSession): Promise<{
  readonly labels: readonly string[];
  readonly initiallyVisibleLabels: readonly string[];
}> {
  const deadline = Date.now() + 30_000;
  const screen = () => session.terminal.snapshot().text;
  const remaining = () => {
    const timeout = deadline - Date.now();
    assert.ok(timeout > 0, "native Codex catalog walk exceeded its deadline");
    return timeout;
  };
  const settled = (cursor?: number) => {
    let previous = "";
    return waitFor(
      () => {
        const text = screen();
        const frame = nativeFrame(text);
        const ready =
          frame && text === previous && (cursor === undefined || frame.cursor === cursor);
        previous = text;
        return ready ? frame : undefined;
      },
      "a settled native Codex picker",
      remaining(),
    );
  };
  await session.sendKeys("/model");
  await waitFor(
    () => (/^[›»]\s*\/model\s*$/m.test(screen()) ? true : undefined),
    "/model typed",
    remaining(),
  );
  await session.sendKeys("\r");
  try {
    let frame = await settled();
    const initiallyVisibleLabels = frame.rows.map((row) => row.label);
    const seen = new Map<number, string>();
    const record = () => {
      for (const row of frame.rows) seen.set(row.number, row.label);
    };
    const move = async (delta: -1 | 1) => {
      remaining();
      await session.sendKeys(delta === 1 ? "\u001b[B" : "\u001b[A");
      return settled(frame.cursor + delta);
    };
    while (frame.cursor > 1) {
      record();
      frame = await move(-1);
    }
    for (;;) {
      record();
      const last = frame.rows.at(-1);
      assert.ok(last, "native Codex picker has model rows");
      if (!frame.below && frame.cursor === last.number) break;
      frame = await move(1);
    }
    const rows = [...seen].sort(([left], [right]) => left - right);
    assert.deepEqual(
      rows.map(([number]) => number),
      Array.from({ length: frame.cursor }, (_, index) => index + 1),
    );
    return { labels: rows.map(([, label]) => label), initiallyVisibleLabels };
  } finally {
    await session.sendKeys("\u001b");
    await waitFor(
      () => (screen().includes("Select Model and Effort") ? undefined : true),
      "native Codex picker to close",
      10_000,
    );
  }
}

function nativeFrame(text: string): NativeFrame | undefined {
  const heading = text.lastIndexOf("Select Model and Effort");
  if (heading < 0) return undefined;
  const picker = text.slice(heading);
  if (!/enter select · esc back|Press enter to confirm or esc to go back/i.test(picker))
    return undefined;
  const rows: NativeRow[] = [];
  let cursor: number | undefined;
  for (const line of picker.split("\n")) {
    const match = /^\s*(›)?\s*(\d+)\.\s+(.+)$/.exec(line);
    if (!match) continue;
    const number = Number(match[2]);
    const label = (match[3] as string)
      .split(/\s{2,}/)[0]
      ?.replace(/\s*\((?:current|default)\)/gi, "");
    assert.ok(label, "native Codex model row has a label");
    rows.push({ number, label });
    if (match[1]) cursor = number;
  }
  return rows.length > 0 && cursor !== undefined
    ? { rows, cursor, below: /^\s*↓\s*$/m.test(picker) }
    : undefined;
}

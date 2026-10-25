/**
 * Marking the Codex configured default on listed rows, read under the process-wide config
 * lock that a concurrent `setModel` holds while Codex's picker has its selection written
 * into config.toml. Covers PRD §5.3 `isDefault` and C-API-23.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import { markCodexDefault, withCodexDefault } from "../../src/codex/config/default-model.ts";
import { restoreCodexConfig, snapshotCodexConfig } from "../../src/codex/config/restore.ts";
import { runCodexModelSwitch } from "../../src/codex/config/transaction.ts";
import type { AgentModelOption } from "../../src/index.ts";
import { restoreCodexHome, tempCodexHome } from "./helpers.ts";

afterEach(restoreCodexHome);

type Flags = Partial<Pick<AgentModelOption, "isCurrent" | "isDefault">>;

function row(id: string, flags: Flags = {}): AgentModelOption {
  return { id, label: id, isCurrent: false, isDefault: false, raw: id, ...flags };
}

const rows = [row("gpt-6.1-sol", { isCurrent: true }), row("gpt-6-astra"), row("gpt-6-luna")];

function defaultIds(options: readonly AgentModelOption[]): readonly string[] {
  return options.filter((option) => option.isDefault).map((option) => option.id);
}

describe("Codex configured default rows", () => {
  test("C-API-23 marks the configured row, matching the config case-insensitively", () => {
    const marked = markCodexDefault(rows, "GPT-6-Astra");
    expect(defaultIds(marked)).toEqual(["gpt-6-astra"]);
    expect(marked[0]).toMatchObject({ isCurrent: true, isDefault: false });
  });

  test("C-API-23 the current row is also the default when it is the configured one", () => {
    expect(markCodexDefault(rows, "gpt-6.1-sol")[0]).toMatchObject({
      isCurrent: true,
      isDefault: true,
    });
  });

  test("C-API-23 marks nothing when no listed model is configured", () => {
    expect(defaultIds(markCodexDefault(rows, undefined))).toEqual([]);
    expect(defaultIds(markCodexDefault(rows, "gpt-unlisted"))).toEqual([]);
  });

  test("C-API-23 a rendered (default) marker wins over the config", () => {
    const rendered = [
      row("gpt-6.1-sol", { isCurrent: true }),
      row("gpt-6-astra", { isDefault: true }),
    ];
    expect(markCodexDefault(rendered, "gpt-6.1-sol")).toBe(rendered);
  });
});

describe("Codex configured default under the config lock", () => {
  test("C-API-23 a listing waits out a concurrent switch's temporary config write", async () => {
    const path = tempCodexHome('model = "gpt-6-astra"\n');
    let finishApply: () => void = () => undefined;
    const switching = runCodexModelSwitch({
      snapshot: () => snapshotCodexConfig(path),
      // Codex's picker persists its selection while the switch is still in flight.
      apply: () => {
        writeFileSync(path, 'model = "gpt-6-luna"\n');
        return new Promise<void>((resolve) => {
          finishApply = resolve;
        });
      },
      restore: (snapshot) => {
        restoreCodexConfig({ path, snapshot });
      },
    });
    let settled = false;
    const listing = withCodexDefault(rows, new AbortController().signal, path).finally(() => {
      settled = true;
    });
    try {
      await setImmediate();
      expect(readFileSync(path, "utf8")).toBe('model = "gpt-6-luna"\n');
      expect(settled, "the listing must not read the switch's temporary selection").toBe(false);
    } finally {
      // Release the process-wide lock even when an assertion fails.
      finishApply();
      await switching;
    }
    expect(defaultIds(await listing)).toEqual(["gpt-6-astra"]);
  });

  test("C-API-23 a listing aborted while waiting for the lock rejects with the abort reason", async () => {
    const path = tempCodexHome('model = "gpt-6-astra"\n');
    let release: () => void = () => undefined;
    const held = runCodexModelSwitch({
      snapshot: () => undefined,
      apply: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      restore: () => undefined,
    });
    try {
      const deadline = new AbortController();
      const listing = withCodexDefault(rows, deadline.signal, path);
      deadline.abort(new Error("Timed out waiting for model picker operation."));
      await expect(listing).rejects.toThrow("Timed out waiting for model picker operation.");
    } finally {
      release();
      await held;
    }
  });
});

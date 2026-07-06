/**
 * Conformance tests for Codex session model listing.
 * Covers PRD §5.7 and C-API-23.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { asScreen, codexPickerCurrentIsDefault } from "../helpers/model-pickers.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession model picker", () => {
  test("C-API-23 listModels drives the picker through the readiness queue", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    ptys[0]!.emitData("codex rendered");
    await expect.poll(() => session.status).toBe("ready");
    const listing = session.listModels({ timeoutMs: 4_000 });
    await expect.poll(() => ptys[0]!.writes.includes("/model")).toBe(true);
    ptys[0]!.emitData(asScreen(codexPickerCurrentIsDefault));
    await expect.poll(() => ptys[0]!.writes.includes("\u001b")).toBe(true);
    ptys[0]!.emitData(asScreen("› "));
    const options = await listing;
    expect(options.map((option) => option.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(options[0]).toMatchObject({ isCurrent: true, isDefault: true });
  });
});

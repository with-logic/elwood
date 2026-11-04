/** A failed hold disposal emits one bounded process diagnostic (PRD §8.1). */
import { openSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { tempDir } from "../helpers/tmp.ts";

const fault = vi.hoisted(() => ({ code: "", active: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: (fd: number) => {
      actual.closeSync(fd);
      if (fault.active) throw Object.assign(new Error("secret/path/99"), { code: fault.code });
    },
  };
});
afterEach(() => {
  fault.active = false;
  vi.restoreAllMocks();
});

for (const [code, expected] of [
  ["EBADF", "EBADF"],
  ["EINTR", "EINTR"],
  ["EIO", "EIO"],
  ["private/path", "UnknownError"],
]) {
  test(`C-STATE-01 disposal reports only bounded ${expected} once per process`, async () => {
    vi.resetModules();
    const { closePublicationDirectory } = await import("../../src/state/publication/close.ts");
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    fault.code = code!;
    fault.active = true;
    closePublicationDirectory(openSync(join(tempDir(), "first"), "w"));
    closePublicationDirectory(openSync(join(tempDir(), "second"), "w"));
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "Could not dispose a launch state directory descriptor.",
      { type: "ElwoodStateDirectoryCloseWarning", code: expected },
    );
  });
}

/**
 * The failure a session reports when it cannot remove Codex's copies of pasted images
 * (PRD §5.3, §5.7, C-API-46): the first failure's errno token, `UnknownError` for a failure
 * without one, and none when every copy is gone or was already gone. `unlink` is replaced so
 * failures without a usable errno, which a real filesystem does not produce on demand, can
 * be exercised; the real-filesystem failure is in `session-clipboard-copies.test.ts`.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { CodexClipboardCopies } from "../../src/codex/images/clipboard-copies.ts";
import { imageCopyRemovalFailedWarning } from "../../src/codex/session/warnings.ts";

const unlink = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>());
vi.mock("node:fs/promises", async (actual) => ({
  ...(await actual<typeof import("node:fs/promises")>()),
  unlink,
}));

/** The failure `removeAll` reports for copies whose removals end with `outcomes`, in order. */
async function failureOf(outcomes: readonly (Error | undefined)[]): Promise<string | undefined> {
  unlink.mockReset();
  for (const outcome of outcomes)
    unlink.mockImplementationOnce(() =>
      outcome === undefined ? Promise.resolve() : Promise.reject(outcome),
    );
  const copies = new CodexClipboardCopies();
  const content = outcomes.map((_, index) => ({
    type: "local_image",
    path: join(tmpdir(), `codex-clipboard-${index}.png`),
  }));
  copies.observe({
    type: "event_msg",
    payload: { type: "item_completed", item: { type: "UserMessage", content } },
  });
  return await new Promise<string | undefined>((done) => copies.removeAll(done));
}

const failed = (code: unknown) => Object.assign(new Error("failed"), { code });

describe("C-API-46 a failed copy removal", () => {
  test("reports the first failure's errno, after trying every copy", async () => {
    expect(await failureOf([undefined, failed("EPERM"), failed("EBUSY")])).toBe("EPERM");
    expect(unlink).toHaveBeenCalledTimes(3);
  });

  test("does not count a copy that is already gone", async () => {
    expect(await failureOf([failed("ENOENT"), undefined])).toBeUndefined();
    expect(await failureOf([failed("ENOENT"), failed("EACCES")])).toBe("EACCES");
    expect(unlink).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["no code", new Error("failed")],
    ["a code that is not an errno token", failed("not an errno: /private/path")],
    ["a code that is not a string", failed(13)],
  ])("with %s reports UnknownError", async (_case, error) => {
    expect(await failureOf([error])).toBe("UnknownError");
  });

  test("is reported content-free", () => {
    expect(imageCopyRemovalFailedWarning("s1", "UnknownError")).toEqual({
      elwoodSessionId: "s1",
      agent: "codex",
      source: "lifecycle",
      code: "image_copy_removal_failed",
      severity: "warning",
      message:
        "Could not remove a temp copy Codex saved of a pasted image (UnknownError); it is left for the OS to reap.",
      errorCode: "UnknownError",
      raw: "image_copy_removal_failed code=UnknownError",
    });
  });
});

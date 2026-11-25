/** Hold one native Git marker lookup at the real filesystem seam (C-ATTN-07). */
import type * as fsp from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";

export async function holdFirstGitLookup(lstatSpy: typeof fsp.lstat, cwd: string) {
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { lstat } = await vi.importActual<typeof fsp>("node:fs/promises");
  let first = true;
  vi.mocked(lstatSpy)
    .mockClear()
    .mockImplementation(async (...options) => {
      if (first && options[0] === join(cwd, ".git")) {
        first = false;
        began.resolve();
        await release.promise;
      }
      return Reflect.apply(lstat, undefined, options);
    });
  return { began: began.promise, release: release.resolve };
}

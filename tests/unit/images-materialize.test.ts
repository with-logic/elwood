/**
 * Coverage for image materialization (PRD §5.3, C-API-44): byte inputs become
 * temp files, paths pass through, cleanup is idempotent and best-effort, and a
 * materialize failure removes the temp dir while preserving the original error.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { materializeImages } from "../../src/core/images/materialize.ts";
import { tempDirForUnit } from "./helpers.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("materializeImages (C-API-44)", () => {
  afterEach(() => {
    // Every mocked-fs test below is undone here, so a failing assertion cannot leak the
    // mock into the next test.
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  test("C-API-44 materializes bytes to temp files and cleans them up", async () => {
    const { paths, cleanup } = await materializeImages([{ data: PNG, format: "png" }]);
    const file = paths[0] as string;
    expect(file.endsWith(".png")).toBe(true);
    expect(readFileSync(file)).toEqual(Buffer.from(PNG));
    await cleanup();
    expect(existsSync(file)).toBe(false);
    await cleanup(); // idempotent
  });

  test("C-API-44 resolves an existing path without materializing, mixed with bytes", async () => {
    const dir = tempDirForUnit();
    const file = join(dir, "a.png");
    writeFileSync(file, PNG);
    const { paths, cleanup } = await materializeImages([
      { path: file },
      { data: PNG, format: "gif" },
    ]);
    expect(paths[0]).toBe(file);
    expect((paths[1] as string).endsWith(".gif")).toBe(true);
    await cleanup();
    expect(existsSync(file)).toBe(true); // pre-existing path never removed
    expect(existsSync(paths[1] as string)).toBe(false);
  });

  test("C-API-44 path-only images create no temp dir and cleanup is a no-op", async () => {
    const dir = tempDirForUnit();
    const file = join(dir, "only.png");
    writeFileSync(file, PNG);
    const { paths, cleanup } = await materializeImages([{ path: file }]);
    expect(paths).toEqual([file]);
    await cleanup(); // dir is undefined → cleanup returns without removing anything
    expect(existsSync(file)).toBe(true);
  });

  test("C-API-44 uses the right extension per format", async () => {
    const { paths, cleanup } = await materializeImages([
      { data: PNG, format: "jpeg" },
      { data: PNG, format: "webp" },
    ]);
    expect((paths[0] as string).endsWith(".jpg")).toBe(true);
    expect((paths[1] as string).endsWith(".webp")).toBe(true);
    await cleanup();
  });

  test("C-API-44 cleans up and rethrows the ORIGINAL error when a write fails", async () => {
    vi.resetModules();
    const removed: string[] = [];
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        writeFile: () => Promise.reject(new Error("ENOSPC")),
        rm: (path: string, ...rest: unknown[]) => {
          removed.push(path);
          return (actual.rm as (...a: unknown[]) => Promise<void>)(path, ...rest);
        },
      };
    });
    const { materializeImages: mocked } = await import("../../src/core/images/materialize.ts");
    // A raw platform error is wrapped as the stable typed image_attach_failed,
    // with the underlying reason preserved as a bounded cause (C-ERR-01).
    await expect(mocked([{ data: PNG, format: "png" }])).rejects.toMatchObject({
      code: "image_attach_failed",
      details: { cause: "ENOSPC" },
    });
    expect(removed.length).toBeGreaterThan(0);
  });

  test("C-API-44 a non-Error materialize failure is stringified into the cause", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return { ...actual, writeFile: () => Promise.reject("disk-gone") };
    });
    const { materializeImages: mocked } = await import("../../src/core/images/materialize.ts");
    await expect(mocked([{ data: PNG, format: "png" }])).rejects.toMatchObject({
      code: "image_attach_failed",
      details: { cause: "disk-gone" },
    });
  });

  test("C-API-44 a cleanup failure never masks the ORIGINAL materialize failure", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        writeFile: () => Promise.reject(new Error("ENOSPC")),
        rm: () => Promise.reject(new Error("rm failed")), // cleanup itself throws
      };
    });
    const { materializeImages: mocked } = await import("../../src/core/images/materialize.ts");
    // The rm rejection is swallowed; the typed materialize failure still surfaces.
    await expect(mocked([{ data: PNG, format: "png" }])).rejects.toMatchObject({
      code: "image_attach_failed",
    });
  });
});

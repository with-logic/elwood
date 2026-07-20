/**
 * Coverage for image resolution/validation (PRD §5.3, C-API-44):
 * path validation, byte materialization to temp files, cleanup, and the
 * `invalid_image` rejections that fire before any temp file is written.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import { resolveImages } from "../../src/core/images/resolve.ts";
import { tempDirForUnit } from "./helpers.ts";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("resolveImages (C-API-44)", () => {
  test("C-API-44 resolves an existing file path to an absolute path", () => {
    const dir = tempDirForUnit();
    const file = join(dir, "shot.png");
    writeFileSync(file, PNG_BYTES);
    const { paths, cleanup } = resolveImages([{ path: file }]);
    expect(paths).toEqual([file]);
    cleanup(); // no temp file created → cleanup is a no-op and file survives
    expect(existsSync(file)).toBe(true);
  });

  test("C-API-44 materializes byte inputs to temp files and cleans them up", () => {
    const { paths, cleanup } = resolveImages([{ data: PNG_BYTES, format: "png" }]);
    expect(paths).toHaveLength(1);
    const file = paths[0] as string;
    expect(file.endsWith(".png")).toBe(true);
    expect(readFileSync(file)).toEqual(Buffer.from(PNG_BYTES));
    cleanup();
    expect(existsSync(file)).toBe(false);
    cleanup(); // idempotent second call is safe
  });

  test("C-API-44 uses the right extension per format", () => {
    const { paths, cleanup } = resolveImages([
      { data: PNG_BYTES, format: "jpeg" },
      { data: PNG_BYTES, format: "gif" },
      { data: PNG_BYTES, format: "webp" },
    ]);
    expect((paths[0] as string).endsWith(".jpg")).toBe(true);
    expect((paths[1] as string).endsWith(".gif")).toBe(true);
    expect((paths[2] as string).endsWith(".webp")).toBe(true);
    cleanup();
  });

  test("C-API-44 mixes a path and bytes in one submission", () => {
    const dir = tempDirForUnit();
    const file = join(dir, "a.png");
    writeFileSync(file, PNG_BYTES);
    const { paths, cleanup } = resolveImages([{ path: file }, { data: PNG_BYTES, format: "png" }]);
    expect(paths[0]).toBe(file);
    expect(existsSync(paths[1] as string)).toBe(true);
    cleanup();
    expect(existsSync(file)).toBe(true); // the pre-existing path is never removed
    expect(existsSync(paths[1] as string)).toBe(false);
  });

  test("C-API-44 rejects an unsupported byte format before writing", () => {
    expect(() => resolveImages([{ data: PNG_BYTES, format: "tiff" as never }])).toThrow(
      ElwoodError,
    );
    try {
      resolveImages([{ data: PNG_BYTES, format: "tiff" as never }]);
    } catch (error) {
      expect((error as ElwoodError).code).toBe("invalid_image");
    }
  });

  test("C-API-44 rejects empty byte data", () => {
    expect(() => resolveImages([{ data: new Uint8Array(0), format: "png" }])).toThrow(
      /Image data is empty/,
    );
  });

  test("C-API-44 rejects an empty path", () => {
    expect(() => resolveImages([{ path: "" }])).toThrow(/Image path is empty/);
  });

  test("C-API-44 rejects a non-existent path", () => {
    expect(() => resolveImages([{ path: "/no/such/elwood-image.png" }])).toThrow(/not readable/);
  });

  test("C-API-44 rejects a directory path (not a file)", () => {
    const dir = tempDirForUnit();
    expect(() => resolveImages([{ path: dir }])).toThrow(/not a file/);
  });

  test("C-API-44 validates every input before materializing any temp file", () => {
    const dir = tempDirForUnit();
    const good = join(dir, "good.png");
    writeFileSync(good, PNG_BYTES);
    // A later bad input must reject synchronously; the earlier good bytes must
    // not leave an orphaned temp file behind.
    expect(() =>
      resolveImages([{ data: PNG_BYTES, format: "png" }, { path: "/missing.png" }]),
    ).toThrow(/not readable/);
  });

  test("C-API-44 cleans up and rethrows when materializing bytes fails", async () => {
    // A materialize failure (disk full, permissions) must remove any temp dir it
    // created before rethrowing. Force writeFileSync to throw for this case only.
    vi.resetModules();
    const removed: string[] = [];
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        writeFileSync: () => {
          throw new Error("ENOSPC");
        },
        rmSync: (path: string, ...rest: unknown[]) => {
          removed.push(path);
          return (actual.rmSync as (...a: unknown[]) => void)(path, ...rest);
        },
      };
    });
    const { resolveImages: mocked } = await import("../../src/core/images/resolve.ts");
    expect(() => mocked([{ data: PNG_BYTES, format: "png" }])).toThrow(/ENOSPC/);
    expect(removed.length).toBeGreaterThan(0); // the temp dir was cleaned up
    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});

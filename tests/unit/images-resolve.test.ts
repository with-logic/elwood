/**
 * Coverage for image validation/resolution (PRD §5.3, C-API-44): validation
 * (formats, readability, count/size limits) rejects before any temp file exists;
 * resolution materializes bytes to temp files and cleans them up.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { ElwoodError } from "../../src/core/errors.ts";
import { resolveImages, validateImages } from "../../src/core/images/resolve.ts";
import { imageLimits } from "../../src/core/images/types.ts";
import { tempDirForUnit } from "./helpers.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageCode(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => "no-throw",
    (error) => (error as ElwoodError).code,
  );
}

describe("validateImages (C-API-44)", () => {
  test("C-API-44 accepts an existing file and supported byte formats", async () => {
    const dir = tempDirForUnit();
    const file = join(dir, "shot.png");
    writeFileSync(file, PNG);
    await expect(
      validateImages([{ path: file }, { data: PNG, format: "jpeg" }]),
    ).resolves.toBeUndefined();
  });

  test("C-API-44 rejects an unsupported byte format", async () => {
    expect(await imageCode(() => validateImages([{ data: PNG, format: "tiff" as never }]))).toBe(
      "invalid_image",
    );
  });

  test("C-API-44 rejects empty byte data", async () => {
    await expect(validateImages([{ data: new Uint8Array(0), format: "png" }])).rejects.toThrow(
      /Image data is empty/,
    );
  });

  test("C-API-44 rejects an empty path and a missing path", async () => {
    await expect(validateImages([{ path: "" }])).rejects.toThrow(/empty/);
    expect(await imageCode(() => validateImages([{ path: "/no/such/x.png" }]))).toBe(
      "invalid_image",
    );
  });

  test("C-API-44 rejects a directory (not a file)", async () => {
    const dir = tempDirForUnit();
    await expect(validateImages([{ path: dir }])).rejects.toThrow(/invalid_image|not a/);
  });

  test("C-API-44 rejects a file that is not readable", async () => {
    const dir = tempDirForUnit();
    const file = join(dir, "secret.png");
    writeFileSync(file, PNG);
    chmodSync(file, 0o000);
    try {
      expect(await imageCode(() => validateImages([{ path: file }]))).toBe("invalid_image");
    } finally {
      chmodSync(file, 0o644);
    }
  });

  test("C-API-44 rejects too many images", async () => {
    const many = Array.from({ length: imageLimits.maxCount + 1 }, () => ({
      data: PNG,
      format: "png" as const,
    }));
    await expect(validateImages(many)).rejects.toThrow(/Too many images/);
  });

  test("C-API-44 rejects a byte input over the per-image limit", async () => {
    const big = new Uint8Array(imageLimits.maxBytesPerImage + 1);
    big[0] = 1;
    await expect(validateImages([{ data: big, format: "png" }])).rejects.toThrow(/per-image/);
  });

  test("C-API-44 rejects a path whose file is over the per-image limit", async () => {
    const dir = tempDirForUnit();
    const file = join(dir, "big.png");
    writeFileSync(file, Buffer.alloc(imageLimits.maxBytesPerImage + 1));
    await expect(validateImages([{ path: file }])).rejects.toThrow(/per-image/);
  });

  test("C-API-44 rejects when the aggregate byte total is exceeded", async () => {
    const half = new Uint8Array(imageLimits.maxBytesPerImage);
    half[0] = 1;
    // Three ~25MiB images = ~75MiB > 50MiB total, but each is within per-image.
    await expect(
      validateImages([
        { data: half, format: "png" },
        { data: half, format: "png" },
        { data: half, format: "png" },
      ]),
    ).rejects.toThrow(/total/);
  });
});

describe("resolveImages (C-API-44)", () => {
  test("C-API-44 materializes bytes to temp files and cleans them up", async () => {
    const { paths, cleanup } = await resolveImages([{ data: PNG, format: "png" }]);
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
    const { paths, cleanup } = await resolveImages([{ path: file }, { data: PNG, format: "gif" }]);
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
    const { paths, cleanup } = await resolveImages([{ path: file }]);
    expect(paths).toEqual([file]);
    await cleanup(); // dir is undefined → cleanup returns without removing anything
    expect(existsSync(file)).toBe(true);
  });

  test("C-API-44 uses the right extension per format", async () => {
    const { paths, cleanup } = await resolveImages([
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
    const { resolveImages: mocked } = await import("../../src/core/images/resolve.ts");
    await expect(mocked([{ data: PNG, format: "png" }])).rejects.toThrow(/ENOSPC/);
    expect(removed.length).toBeGreaterThan(0);
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  test("C-API-44 a cleanup failure never masks the ORIGINAL materialize error", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        writeFile: () => Promise.reject(new Error("ENOSPC")),
        rm: () => Promise.reject(new Error("rm failed")), // cleanup itself throws
      };
    });
    const { resolveImages: mocked } = await import("../../src/core/images/resolve.ts");
    // The rm rejection is swallowed; the ORIGINAL ENOSPC still surfaces.
    await expect(mocked([{ data: PNG, format: "png" }])).rejects.toThrow(/ENOSPC/);
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });
});

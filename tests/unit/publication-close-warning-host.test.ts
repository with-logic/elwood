/** Native disposal returns before host warning callbacks use Node error semantics (PRD §8.1). */
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("C-API-61 native close failure returns before a host warning listener throws", () => {
  const helper = new URL("../../src/state/publication/close.ts", import.meta.url).href;
  const script = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const fs = createRequire(import.meta.url)('node:fs');
    const { closePublicationDirectory } = await import(${JSON.stringify(helper)});
    const fd = fs.openSync(process.execPath, 'r');
    const events = [];
    let insideCaller = true;
    process.once('beforeExit', () => console.log(JSON.stringify(events)));
    process.on('warning', warning => {
      if (warning.name !== 'ElwoodStateDirectoryCloseWarning') return;
      events.push({ event: 'host-warning', code: warning.code, insideCaller });
      throw new Error('host-warning-listener-failed');
    });
    // This handler belongs only to the isolated child, never to the library or test host.
    process.once('uncaughtException', error => {
      events.push({ event: 'uncaught-host-callback', message: error.message, insideCaller });
    });
    const nativeClose = fs.closeSync;
    fs.closeSync = candidate => {
      nativeClose(candidate);
      if (candidate === fd)
        throw Object.assign(new Error('native close completed then failed'), { code: 'EIO' });
    };
    syncBuiltinESMExports();
    try {
      closePublicationDirectory(fd);
      let closed = false;
      try { fs.fstatSync(fd); } catch (error) { closed = error.code === 'EBADF'; }
      events.push({ event: 'caller-returned', closed });
    } finally {
      insideCaller = false;
      fs.closeSync = nativeClose;
      syncBuiltinESMExports();
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.signal).toBeNull();
  expect(JSON.parse(child.stdout.trim())).toEqual([
    { event: "caller-returned", closed: true },
    { event: "host-warning", code: "EIO", insideCaller: false },
    {
      event: "uncaught-host-callback",
      message: "host-warning-listener-failed",
      insideCaller: false,
    },
  ]);
});

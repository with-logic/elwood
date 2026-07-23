/**
 * Unit tests for the stable, identity-scoped bridge socket home (PRD §8.1, C-STATE-12).
 * The home is stable across launches of one session yet distinct for two sessions that
 * happen to share an explicit id in different state dirs, so neither sweeps the other's
 * live socket.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ensureSocketHome,
  ownsSocketHome,
  removeOwnSocketFile,
  SOCKET_HOME_PREFIX,
  sessionSocketHome,
} from "../../src/state/socket-home.ts";

const base = { stateDir: "/state/a", elwoodSessionId: "sess-1", adapter: "claude" } as const;

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});
const mode = (path: string) => statSync(path).mode & 0o777;

describe("sessionSocketHome", () => {
  test("is deterministic and stable across launches of the same identity", () => {
    expect(sessionSocketHome(base)).toBe(sessionSocketHome({ ...base }));
  });

  test("lives under the OS temp dir with the shared elwood- prefix", () => {
    const home = sessionSocketHome(base);
    expect(dirname(home)).toBe(tmpdir());
    expect(home.startsWith(join(tmpdir(), SOCKET_HOME_PREFIX))).toBe(true);
  });

  test("a shared explicit id in a different stateDir resolves a DISTINCT home", () => {
    // The residual-risk case: same id, different state dir must not alias onto one home.
    expect(sessionSocketHome(base)).not.toBe(sessionSocketHome({ ...base, stateDir: "/state/b" }));
  });

  test("the same id under a different adapter resolves a DISTINCT home", () => {
    expect(sessionSocketHome(base)).not.toBe(sessionSocketHome({ ...base, adapter: "codex" }));
  });

  test("different session ids resolve DISTINCT homes", () => {
    expect(sessionSocketHome(base)).not.toBe(
      sessionSocketHome({ ...base, elwoodSessionId: "sess-2" }),
    );
  });

  test("ownsSocketHome recognizes only homes this scheme minted", () => {
    expect(ownsSocketHome(join(sessionSocketHome(base), "abcd1234.sock"))).toBe(true);
    expect(ownsSocketHome("/tmp/some-other-dir/abcd1234.sock")).toBe(false);
  });
});

describe("ensureSocketHome", () => {
  test("creates a fresh home privately (0700)", () => {
    scratch = mkdtempSync(join(tmpdir(), "elwood-ensure-"));
    const home = join(scratch, "home");
    ensureSocketHome(home);
    expect(mode(home)).toBe(0o700);
  });

  test("restores a PRE-EXISTING permissive home to 0700 (§8.1)", () => {
    // The home is deterministic and reused, so a launch must tighten a home left at a
    // looser mode — mkdirSync's mode applies only on fresh creation.
    scratch = mkdtempSync(join(tmpdir(), "elwood-ensure-"));
    const home = join(scratch, "home");
    mkdirSync(home);
    chmodSync(home, 0o755);
    ensureSocketHome(home);
    expect(mode(home)).toBe(0o700);
  });

  test("rejects a planted NON-directory at the predictable path", () => {
    scratch = mkdtempSync(join(tmpdir(), "elwood-ensure-"));
    const home = join(scratch, "home");
    writeFileSync(home, "planted"); // an attacker-planted file where the home would go
    expect(() => ensureSocketHome(home)).toThrow(/not a private directory/);
  });
});

describe("removeOwnSocketFile", () => {
  test("removes only the launch's own socket file, leaving the shared home", () => {
    scratch = mkdtempSync(join(tmpdir(), `${SOCKET_HOME_PREFIX}own-`));
    const sock = join(scratch, "abcd1234.sock");
    writeFileSync(sock, "");
    removeOwnSocketFile(sock);
    expect(existsSync(sock)).toBe(false);
    expect(existsSync(scratch)).toBe(true); // the shared home survives
  });

  test("no-ops on a path outside a home this scheme owns", () => {
    scratch = mkdtempSync(join(tmpdir(), "not-owned-"));
    const sock = join(scratch, "abcd1234.sock");
    writeFileSync(sock, "");
    removeOwnSocketFile(sock); // parent dir lacks the elwood- prefix: untouched
    expect(existsSync(sock)).toBe(true);
  });
});

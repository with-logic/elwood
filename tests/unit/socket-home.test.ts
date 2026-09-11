/**
 * Unit tests for the stable, identity-scoped bridge socket home (PRD §8.1, C-STATE-12).
 * The home is stable across launches of one session yet distinct for two sessions that
 * happen to share an explicit id in different state dirs, so neither sweeps the other's
 * live socket.
 */

import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ensureSocketHome,
  ownsSocketHome,
  removeOwnSocketFile,
  removeSocketHome,
  SOCKET_HOME_PREFIX,
  sessionSocketHome,
} from "../../src/state/socket-home.ts";
import { tempDir } from "../helpers/tmp.ts";

const base = { stateDir: "/state/a", elwoodSessionId: "sess-1", adapter: "claude" } as const;

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

  test("§8.1 equivalent spellings of one stateDir resolve the SAME home", () => {
    // Session dirs are keyed on the resolved state dir; the socket home must agree,
    // or a `..`/relative spelling would mint a second home teardown never sweeps.
    expect(sessionSocketHome({ ...base, stateDir: "/state/a/../a/" })).toBe(
      sessionSocketHome(base),
    );
    expect(sessionSocketHome({ ...base, stateDir: "rel/state" })).toBe(
      sessionSocketHome({ ...base, stateDir: resolve("rel/state") }),
    );
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
    expect(ownsSocketHome(sessionSocketHome(base))).toBe(true);
    expect(ownsSocketHome("/tmp/some-other-dir")).toBe(false);
  });
});

describe("ensureSocketHome", () => {
  test("creates a fresh home privately (0700)", () => {
    const home = join(tempDir("elwood-ensure-"), "home");
    ensureSocketHome(home);
    expect(mode(home)).toBe(0o700);
  });

  test("restores a PRE-EXISTING permissive home to 0700 (§8.1)", () => {
    // The home is deterministic and reused, so a launch must tighten a home left at a
    // looser mode — mkdirSync's mode applies only on fresh creation.
    const home = join(tempDir("elwood-ensure-"), "home");
    mkdirSync(home);
    chmodSync(home, 0o755);
    ensureSocketHome(home);
    expect(mode(home)).toBe(0o700);
  });

  test("rejects a planted NON-directory at the predictable path", () => {
    const home = join(tempDir("elwood-ensure-"), "home");
    writeFileSync(home, "planted"); // an attacker-planted file where the home would go
    expect(() => ensureSocketHome(home)).toThrow(/not a private directory/);
  });
});

describe("removeOwnSocketFile", () => {
  test("removes only the launch's own socket file, leaving the shared home", () => {
    const home = tempDir(`${SOCKET_HOME_PREFIX}own-`);
    const sock = join(home, "abcd1234.sock");
    writeFileSync(sock, "");
    removeOwnSocketFile(sock);
    expect(existsSync(sock)).toBe(false);
    expect(existsSync(home)).toBe(true); // the shared home survives
  });

  test("no-ops on a path outside a home this scheme owns", () => {
    const sock = join(tempDir("not-owned-"), "abcd1234.sock");
    writeFileSync(sock, "");
    removeOwnSocketFile(sock); // parent dir lacks the elwood- prefix: untouched
    expect(existsSync(sock)).toBe(true);
  });
});

describe("removeSocketHome", () => {
  test("removes an owned home whole and leaves any other directory alone", () => {
    const owned = tempDir(`${SOCKET_HOME_PREFIX}whole-`);
    writeFileSync(join(owned, "a.sock"), "");
    removeSocketHome(owned);
    expect(existsSync(owned)).toBe(false);
    const foreign = tempDir("not-owned-");
    removeSocketHome(foreign);
    expect(existsSync(foreign)).toBe(true);
  });
});

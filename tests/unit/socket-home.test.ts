/**
 * Unit tests for the stable, identity-scoped bridge socket home (PRD §8.1, C-STATE-12).
 * The home is stable across launches of one session yet distinct for two sessions that
 * happen to share an explicit id in different state dirs, so neither sweeps the other's
 * live socket.
 */

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ownsSocketHome,
  SOCKET_HOME_PREFIX,
  sessionSocketHome,
} from "../../src/state/socket-home.ts";

const base = { stateDir: "/state/a", elwoodSessionId: "sess-1", adapter: "claude" } as const;

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

/**
 * The fake-PTY suites' private socket-home roots (`tests/helpers/fake-socket-homes.ts`,
 * PRD §8.1). Cleanup stops every hook bridge the test started before it removes the
 * root, so no listener outlives its test in a reused Vitest worker, and with no private
 * root it removes nothing.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { noDecision } from "../../src/bridge/parse.ts";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import { canonicalSessionSocketHome } from "../../src/state/socket-home.ts";
import { isolateFakeSocketHomes, removeFakeSocketHomes } from "../helpers/fake-socket-homes.ts";
import { tempDir } from "../helpers/tmp.ts";

const bridgeIn = (dir: string) =>
  new HookBridgeServer(
    join(dir, "abcd1234.sock"),
    "token",
    () => Promise.resolve(noDecision()),
    () => undefined,
    () => false,
  );

/** The directory socket homes are minted under right now. */
const socketHomeRoot = () =>
  dirname(canonicalSessionSocketHome({ stateDir: "/s", elwoodSessionId: "id", adapter: "claude" }));

describe("fake socket homes", () => {
  test("§8.1 cleanup stops every bridge the test started, then removes the root", async () => {
    const root = isolateFakeSocketHomes();
    expect(isolateFakeSocketHomes()).toBe(root); // one root per test
    expect(socketHomeRoot()).toBe(root);
    const bridge = bridgeIn(root);
    await bridge.start();
    const stop = vi.spyOn(bridge, "stop");
    expect(readdirSync(root)).toEqual(["abcd1234.sock"]);
    await removeFakeSocketHomes();
    expect(stop).toHaveBeenCalledOnce();
    expect(existsSync(root)).toBe(false);
    expect(socketHomeRoot()).not.toBe(root);
  });

  test("§8.1 cleanup with no private root removes nothing", async () => {
    const sibling = tempDir("elwood_test_sock-sibling-");
    writeFileSync(join(sibling, "keep"), "");
    expect(socketHomeRoot()).toBe(tmpdir()); // the real root
    await removeFakeSocketHomes(); // never isolated
    isolateFakeSocketHomes();
    await removeFakeSocketHomes();
    await removeFakeSocketHomes(); // already removed
    expect(readdirSync(sibling)).toEqual(["keep"]);
    expect(socketHomeRoot()).toBe(tmpdir());
  });
});

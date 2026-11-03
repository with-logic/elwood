/**
 * The login copy an e2e Claude config dir holds (`tests/e2e/claude-login.ts`, PRD §12,
 * C-E2E-23): the Claude login without its refresh token, and nothing for a credential that
 * holds no usable login.
 */

import { expect, test } from "vitest";
import { accessOnlyLogin } from "../e2e/claude-login.ts";

test("C-E2E-23 the copy keeps the access token and drops the refresh token and MCP tokens", () => {
  const credentials = JSON.stringify({
    claudeAiOauth: {
      accessToken: "access",
      refreshToken: "rotating",
      refreshTokenExpiresAt: 2,
      expiresAt: 1,
    },
    mcpOAuth: { server: { accessToken: "mcp" } },
  });
  expect(JSON.parse(accessOnlyLogin(credentials, "login") ?? "null")).toEqual({
    claudeAiOauth: { accessToken: "access", expiresAt: 1 },
  });
});

test.each([
  "null",
  "{}",
  '{"claudeAiOauth":null}',
  '{"claudeAiOauth":{}}',
  '{"claudeAiOauth":{"accessToken":""}}',
  '{"claudeAiOauth":{"accessToken":7}}',
  '{"claudeAiOauth":{"refreshToken":"rotating"}}',
])("C-E2E-23 a credential without an access token (%s) holds no login", (credentials) => {
  expect(accessOnlyLogin(credentials, "login")).toBeUndefined();
});

test("C-E2E-23 a credential that is not JSON names its source, never its contents", () => {
  expect(() => accessOnlyLogin("SECRET-CANARY", "The user's Claude login")).toThrow(
    /^The user's Claude login is not JSON$/,
  );
});

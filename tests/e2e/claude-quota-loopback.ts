/** Synthetic Claude Messages gateway fixture for native quota warnings (C-API-68). */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export function fixtureGateway(resetsAt: number, requests: string[], nativeLimitType: string) {
  return createServer((request, response) => {
    request.resume();
    if (request.method !== "POST" || request.url?.split("?")[0] !== "/v1/messages") {
      response.writeHead(404).end();
      return;
    }
    requests.push(request.url);
    response.writeHead(429, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": nativeLimitType,
      "anthropic-ratelimit-unified-reset": String(resetsAt),
      "anthropic-ratelimit-unified-overage-status": "rejected",
      "anthropic-ratelimit-unified-overage-disabled-reason": "overage_disabled",
    });
    response.end(
      JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Synthetic quota rejection" },
      }),
    );
  });
}

export function localGatewayMarker(): string {
  // Claude recognizes the intended gateway path by its audience. Nothing signs or authenticates this marker.
  const component = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    component({ alg: "none" }),
    component({ aud: "claude-gateway" }),
    randomBytes(8).toString("hex"),
  ].join(".");
}

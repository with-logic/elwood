/**
 * Static HTTP routing for the browser dev app.
 * Implements PRD §11.
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { moduleRequire } from "../core/module-require.ts";
import { clientScript, renderHtml } from "./web-assets.ts";

const require = moduleRequire(import.meta.url);

/** Build the HTTP request handler that serves the app shell and vendor assets. */
export function createHttpHandler(input: {
  readonly cwd: string;
  readonly token: string;
}): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const path = request.url?.split("?")[0] ?? "/";
    if (path === "/") {
      send(response, "text/html; charset=utf-8", renderHtml(input.cwd, input.token));
    } else if (path === "/client.js") {
      send(response, "text/javascript; charset=utf-8", clientScript());
    } else if (path === "/vendor/xterm.mjs") {
      sendFile(
        response,
        "text/javascript; charset=utf-8",
        packageFile("@xterm/xterm", "lib/xterm.mjs"),
      );
    } else if (path === "/vendor/addon-fit.mjs") {
      sendFile(
        response,
        "text/javascript; charset=utf-8",
        packageFile("@xterm/addon-fit", "lib/addon-fit.mjs"),
      );
    } else if (path === "/vendor/xterm.css") {
      sendFile(response, "text/css; charset=utf-8", packageFile("@xterm/xterm", "css/xterm.css"));
    } else {
      response.writeHead(404);
      response.end("not found");
    }
  };
}

function sendFile(response: ServerResponse, contentType: string, path: string): void {
  send(response, contentType, readFileSync(path, "utf8"));
}

function send(response: ServerResponse, contentType: string, body: string): void {
  response.writeHead(200, { "content-type": contentType });
  response.end(body);
}

function packageFile(packageName: string, relativePath: string): string {
  return join(dirname(require.resolve(`${packageName}/package.json`)), relativePath);
}

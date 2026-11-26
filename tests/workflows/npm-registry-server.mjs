/**
 * Serves npm registry documents on localhost for the release publish tests:
 * the recorded @with-logic/elwood packument, a 500 for
 * @with-logic/registry-down, and a 404 for anything else. Prints its port.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const packument = readFileSync(new URL("./fixtures/elwood-packument.json", import.meta.url));

const server = createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url ?? "/", "http://registry").pathname.slice(1));
  if (name === "@with-logic/elwood") {
    response.writeHead(200, { "content-type": "application/json" }).end(packument);
  } else if (name === "@with-logic/registry-down") {
    response.writeHead(500, { "content-type": "application/json" }).end('{"error":"fixture"}');
  } else {
    response.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
  }
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});

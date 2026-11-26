/**
 * Serves npm registry documents on localhost for npm-registry-fixture.mjs.
 * Once listening, it writes an npmrc for itself to the path in its first
 * argument, as actions/setup-node writes one, and prints its port.
 * @with-logic/elwood is the recorded packument, and
 * @with-logic/elwood-unrecorded is a copy of it without a commit or publisher
 * for 0.8.0. @with-logic/registry-down answers 500, and anything else 404.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const recorded = readFileSync(new URL("./fixtures/elwood-packument.json", import.meta.url), "utf8");

const unrecorded = JSON.parse(
  recorded.replaceAll("@with-logic/elwood", "@with-logic/elwood-unrecorded"),
);
delete unrecorded.versions["0.8.0"].gitHead;
delete unrecorded.versions["0.8.0"]._npmUser;

const packuments = new Map([
  ["@with-logic/elwood", recorded],
  ["@with-logic/elwood-unrecorded", JSON.stringify(unrecorded)],
]);

const server = createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url ?? "/", "http://registry").pathname.slice(1));
  const packument = packuments.get(name);
  if (packument) {
    response.writeHead(200, { "content-type": "application/json" }).end(packument);
  } else if (name === "@with-logic/registry-down") {
    response.writeHead(500, { "content-type": "application/json" }).end('{"error":"fixture"}');
  } else {
    response.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
  }
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(
    process.argv[2],
    `//127.0.0.1:${port}/:_authToken=\${NODE_AUTH_TOKEN}\nregistry=http://127.0.0.1:${port}/\n`,
  );
  process.stdout.write(`${port}\n`);
});

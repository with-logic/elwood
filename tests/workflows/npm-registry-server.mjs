/**
 * Serves npm registry documents on localhost for npm-registry-fixture.mjs.
 * Once listening, it writes an npmrc for itself to the path in its first
 * argument, as actions/setup-node writes one, and prints its port.
 * `/<name>` answers a packument and `/<name>/<version>` one version's
 * document, as registry.npmjs.org does. @with-logic/elwood is the recorded
 * packument. Two copies of it change one recorded fact each:
 * @with-logic/elwood-reconfigured has another trusted-publisher configuration,
 * and @with-logic/elwood-unrecorded has no commit or publisher for 0.8.0.
 * @with-logic/registry-down answers 500, and anything else 404.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const recorded = readFileSync(new URL("./fixtures/elwood-packument.json", import.meta.url), "utf8");

function copy(name) {
  return JSON.parse(recorded.replaceAll("@with-logic/elwood", name));
}

const reconfigured = copy("@with-logic/elwood-reconfigured");
for (const version of Object.values(reconfigured.versions)) {
  const publisher = version._npmUser.trustedPublisher;
  if (publisher) publisher.oidcConfigId = "00000000-0000-4000-8000-000000000000";
}
const unrecorded = copy("@with-logic/elwood-unrecorded");
delete unrecorded.versions["0.8.0"].gitHead;
delete unrecorded.versions["0.8.0"]._npmUser;

const packuments = new Map(
  [JSON.parse(recorded), reconfigured, unrecorded].map((packument) => [packument.name, packument]),
);

/** Returns the document a registry path names, or undefined for a 404. */
function documentAt(path) {
  if (packuments.has(path)) return packuments.get(path);
  const slash = path.lastIndexOf("/");
  return packuments.get(path.slice(0, slash))?.versions[path.slice(slash + 1)];
}

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? "/", "http://registry").pathname.slice(1));
  const document = documentAt(path);
  if (document) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(document));
  } else if (path.startsWith("@with-logic/registry-down")) {
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

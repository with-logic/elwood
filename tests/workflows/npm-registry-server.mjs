/**
 * Serves npm registry documents on localhost for npm-registry-fixture.mjs.
 * Once listening, it writes an npmrc for itself to the path in its first
 * argument, as actions/setup-node writes one, and prints its port.
 * `/<name>` answers a packument, and `/<name>/<version>` the packument's entry
 * for that version or a 404 naming it, as registry.npmjs.org was checked to
 * answer for each recorded version and a missing one.
 * @with-logic/elwood is the recorded packument. Copies of it change one
 * recorded fact each: @with-logic/elwood-reconfigured has another
 * trusted-publisher configuration, and @with-logic/elwood-unrecorded has no
 * commit or publisher for 0.8.0 and no configuration ID for 0.7.0.
 * @with-logic/elwood-flaky answers 503, and @with-logic/elwood-dropped closes
 * the connection, the first time each path is requested.
 * @with-logic/registry-down answers 500, @with-logic/registry-garbled answers
 * 200 with a body that is not JSON, and anything else 404.
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
delete unrecorded.versions["0.7.0"]._npmUser.trustedPublisher.oidcConfigId;

const packuments = new Map(
  [
    JSON.parse(recorded),
    reconfigured,
    unrecorded,
    copy("@with-logic/elwood-flaky"),
    copy("@with-logic/elwood-dropped"),
  ].map((packument) => [packument.name, packument]),
);

/** Returns the status and document registry.npmjs.org answers a path with. */
function documentAt(path) {
  if (packuments.has(path)) return [200, packuments.get(path)];
  const slash = path.lastIndexOf("/");
  const versions = packuments.get(path.slice(0, slash))?.versions;
  if (!versions) return [404, { error: "Not found" }];
  const version = path.slice(slash + 1);
  return Object.hasOwn(versions, version)
    ? [200, versions[version]]
    : [404, `version not found: ${version}`];
}

const interrupted = new Set();

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? "/", "http://registry").pathname.slice(1));
  const reply = (status, body) =>
    response.writeHead(status, { "content-type": "application/json" }).end(body);
  const scope = path.split("/", 2).join("/");
  if (scope === "@with-logic/registry-down") return reply(500, '{"error":"fixture"}');
  if (scope === "@with-logic/registry-garbled") return reply(200, "<!doctype html>");
  if (/^@with-logic\/elwood-(?:flaky|dropped)$/u.test(scope) && !interrupted.has(path)) {
    interrupted.add(path);
    if (scope.endsWith("dropped")) return request.socket.destroy();
    return reply(503, '{"error":"fixture"}');
  }
  const [status, document] = documentAt(path);
  return reply(status, JSON.stringify(document));
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(
    process.argv[2],
    `//127.0.0.1:${port}/:_authToken=\${NODE_AUTH_TOKEN}\nregistry=http://127.0.0.1:${port}/\n`,
  );
  process.stdout.write(`${port}\n`);
});

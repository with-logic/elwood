/**
 * Serves npm registry documents on localhost for npm-registry-fixture.mjs.
 * Once listening, it writes an npmrc for itself to the path in its first
 * argument, as actions/setup-node writes one, and prints its port.
 * `/<name>` answers a packument, and `/<name>/<version>` the packument's entry
 * for that version or a 404 naming it, as registry.npmjs.org was checked to
 * answer for each recorded version and a missing one.
 * @with-logic/elwood is the recorded packument. Copies of it vary what is
 * recorded or how it is served: @with-logic/elwood-reconfigured has another
 * trusted-publisher configuration ID on every trusted release, and
 * @with-logic/elwood-unrecorded has no `gitHead` or `_npmUser` for 0.8.0, no
 * configuration ID for 0.7.0, and neither in its expected shape for 0.6.1.
 * Above 0.6.1, @with-logic/elwood-deprecated has only versions npm would not
 * keep `latest` on: deprecated ones and a prerelease.
 * @with-logic/elwood-flaky fails each path's first requests in the ways
 * `interruptions` lists, then answers as recorded.
 * @with-logic/registry-down answers 500, @with-logic/registry-garbled answers
 * 200 with a body that is not JSON, @with-logic/registry-oversized answers 200
 * with 2 MiB, and anything else 404.
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
unrecorded.versions["0.6.1"].gitHead = "main\n::error::forged";
unrecorded.versions["0.6.1"]._npmUser.trustedPublisher.oidcConfigId = "x".repeat(65);
const deprecated = copy("@with-logic/elwood-deprecated");
deprecated.versions["0.9.0-rc.1"] = { ...deprecated.versions["0.8.0"], version: "0.9.0-rc.1" };
for (const version of ["0.7.0", "0.8.0"]) deprecated.versions[version].deprecated = "fixture";

const packuments = new Map(
  [
    JSON.parse(recorded),
    reconfigured,
    unrecorded,
    deprecated,
    copy("@with-logic/elwood-flaky"),
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

// Each transient failure npm retries, in the order the flaky copy answers a
// path with them: the connection closed before and during the answer, then
// HTTP 408, 429 and 503.
const interruptions = [
  ({ request }) => request.socket.destroy(),
  ({ request, response }) => {
    response.writeHead(200, { "content-length": "4096", "content-type": "application/json" });
    response.write('{"name":', () => request.socket.destroy());
  },
  ({ reply }) => reply(408, '{"error":"fixture"}'),
  ({ reply }) => reply(429, '{"error":"fixture"}'),
  ({ reply }) => reply(503, '{"error":"fixture"}'),
];
const requestsByPath = new Map();

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url ?? "/", "http://registry").pathname.slice(1));
  const reply = (status, body) =>
    response.writeHead(status, { "content-type": "application/json" }).end(body);
  const packageName = path.split("/", 2).join("/");
  if (packageName === "@with-logic/registry-down") return reply(500, '{"error":"fixture"}');
  if (packageName === "@with-logic/registry-garbled") return reply(200, "<!doctype html>");
  if (packageName === "@with-logic/registry-oversized") {
    return reply(200, `${" ".repeat(2 * 1024 * 1024)}{}`);
  }
  if (packageName === "@with-logic/elwood-flaky") {
    const requests = requestsByPath.get(path) ?? 0;
    requestsByPath.set(path, requests + 1);
    if (requests < interruptions.length)
      return interruptions[requests]({ request, response, reply });
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

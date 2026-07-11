"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const packageMetadata = require("../package.json");
const serverMetadata = require("../server.json");

test("MCP Registry metadata matches the npm package identity", () => {
  assert.equal(packageMetadata.mcpName, serverMetadata.name);
  assert.equal(packageMetadata.version, serverMetadata.version);
  assert.equal(serverMetadata.description.length <= 100, true);
  assert.equal(serverMetadata.repository.url, packageMetadata.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
  assert.equal(serverMetadata.packages.length, 1);

  const npmPackage = serverMetadata.packages[0];
  assert.equal(npmPackage.registryType, "npm");
  assert.equal(npmPackage.identifier, packageMetadata.name);
  assert.equal(npmPackage.version, packageMetadata.version);
  assert.deepEqual(npmPackage.transport, { type: "stdio" });
});

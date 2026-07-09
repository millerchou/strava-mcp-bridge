"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  defaultDataDir,
  expandPath,
  resolveDataPaths,
} = require("../src/paths");

test("default data dir uses macOS Application Support", () => {
  assert.equal(
    defaultDataDir({ homeDir: "/Users/alice" }),
    "/Users/alice/Library/Application Support/strava-mcp-bridge",
  );
});

test("expandPath expands home and resolves relative paths", () => {
  assert.equal(expandPath("~/strava", { homeDir: "/Users/alice", cwd: "/tmp" }), "/Users/alice/strava");
  assert.equal(expandPath("streams", { homeDir: "/Users/alice", cwd: "/tmp/project" }), "/tmp/project/streams");
});

test("resolveDataPaths defaults streams under data dir", () => {
  assert.deepEqual(resolveDataPaths({
    dataDir: "~/Library/Application Support/custom",
    homeDir: "/Users/alice",
    cwd: "/tmp/project",
  }), {
    dataDir: "/Users/alice/Library/Application Support/custom",
    streamOutputDir: "/Users/alice/Library/Application Support/custom/streams",
  });
});

test("resolveDataPaths keeps explicit stream output dir independent", () => {
  assert.deepEqual(resolveDataPaths({
    dataDir: "~/bridge-data",
    streamOutputDir: "repo-streams",
    homeDir: "/Users/alice",
    cwd: "/tmp/project",
  }), {
    dataDir: "/Users/alice/bridge-data",
    streamOutputDir: path.join("/tmp/project", "repo-streams"),
  });
});

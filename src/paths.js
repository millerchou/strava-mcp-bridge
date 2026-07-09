"use strict";

const os = require("node:os");
const path = require("node:path");

function defaultDataDir({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, "Library", "Application Support", "strava-mcp-bridge");
}

function expandPath(value, {
  cwd = process.cwd(),
  homeDir = os.homedir(),
} = {}) {
  if (!value) return "";

  let expanded = String(value);
  if (expanded === "~") {
    expanded = homeDir;
  } else if (expanded.startsWith("~/")) {
    expanded = path.join(homeDir, expanded.slice(2));
  }

  return path.resolve(cwd, expanded);
}

function resolveDataPaths({
  dataDir,
  streamOutputDir,
  cwd = process.cwd(),
  homeDir = os.homedir(),
} = {}) {
  const resolvedDataDir = expandPath(dataDir || defaultDataDir({ homeDir }), { cwd, homeDir });
  return {
    dataDir: resolvedDataDir,
    streamOutputDir: streamOutputDir
      ? expandPath(streamOutputDir, { cwd, homeDir })
      : path.join(resolvedDataDir, "streams"),
  };
}

module.exports = {
  defaultDataDir,
  expandPath,
  resolveDataPaths,
};

"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "darwin" || process.arch !== "arm64") {
  process.stderr.write("strava-mcp-bridge only supports Apple Silicon macOS (darwin arm64).\n");
  process.exit(1);
}

const script = path.join(__dirname, "build-keychain-helper.sh");
const result = spawnSync("sh", [script], {
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(`failed to build native Keychain helper: ${result.error.message}\n`);
  if (result.error.code === "ENOENT") {
    process.stderr.write("Install Xcode Command Line Tools with: xcode-select --install\n");
  }
  process.exit(1);
}

if (result.status === 127) {
  process.stderr.write("failed to build native Keychain helper: swiftc was not found.\n");
  process.stderr.write("Install Xcode Command Line Tools with: xcode-select --install\n");
}

process.exit(result.status || 0);

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const CLI = path.join(__dirname, "..", "bin", "strava-mcp-bridge.js");

test("CLI help loads without syntax errors", () => {
  const result = spawnCli(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /strava-mcp-bridge bootstrap/);
  assert.equal(result.stderr, "");
});

test("CLI config codex prints a usable MCP snippet", () => {
  const result = spawnCli([
    "config",
    "codex",
    "--profile",
    "training-sync",
    "--stream-output-dir",
    "/tmp/strava-streams",
  ]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[mcp_servers\.strava_bridge\]/);
  assert.match(result.stdout, /get_activity_streams/);
  assert.match(result.stdout, /\/tmp\/strava-streams/);
  assert.equal(result.stderr, "");
});

test("auth remove without --yes is a dry run that touches nothing", () => {
  const result = spawnCli(["auth", "remove"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Would remove Keychain item/);
  assert.match(result.stdout, /--yes/);
  assert.equal(result.stderr, "");
});

test("auth remove --json dry run reports dryRun without removing", () => {
  const result = spawnCli(["auth", "remove", "--json"]);

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.command, "remove");
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.removed, false);
  assert.match(parsed.nextAction, /--yes/);
});

test("config codex accumulates repeated --allow-tool flags", () => {
  const result = spawnCli([
    "config", "codex",
    "--allow-tool", "health",
    "--allow-tool", "eligibility",
  ]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /health,eligibility/);
});

test("bootstrap rejects an invalid profile before reporting success", () => {
  const result = spawnCli(["bootstrap", "--skip-setup", "--profile", "bogus"], {
    STRAVA_MCP_KEYCHAIN_HELPER: path.join(__dirname, "does-not-exist-helper"),
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /bootstrap complete/);
  assert.doesNotMatch(result.stdout, /^null$/m);
  assert.match(result.stderr, /code: invalid-profile/);
});

test("auth status reports a classified error instead of a bare exception", () => {
  const helper = path.join(__dirname, "does-not-exist-helper");

  const plain = spawnCli(["auth", "status"], { STRAVA_MCP_KEYCHAIN_HELPER: helper });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /code: helper-missing/);

  const json = spawnCli(["auth", "status", "--json"], { STRAVA_MCP_KEYCHAIN_HELPER: helper });
  assert.equal(json.status, 1);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "helper-missing");
});

test("config codex --help wins even alongside an invalid profile", () => {
  const result = spawnCli(["config", "codex", "--profile", "bogus", "--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /strava-mcp-bridge config codex/);
  assert.equal(result.stderr, "");
});

test("setup --help prints usage instead of building", () => {
  const result = spawnCli(["setup", "--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /strava-mcp-bridge setup/);
  assert.match(result.stdout, /Keychain helper/);
});

test("bootstrap prints the Keychain dialog notice before touching the Keychain", () => {
  const result = spawnCli(["bootstrap", "--skip-setup"], {
    STRAVA_MCP_KEYCHAIN_HELPER: path.join(__dirname, "does-not-exist-helper"),
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Always Allow/);
  assert.match(result.stdout, /Claude Code-credentials/);
  assert.match(result.stderr, /helper-missing/);
});

function spawnCli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

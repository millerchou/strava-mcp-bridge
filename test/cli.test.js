"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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

test("CLI installs the bundled Codex skill with explicit overwrite protection", (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "strava-skill-cli-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  const installed = spawnCli([
    "skill", "install", "--project-dir", projectDir, "--json",
  ]);
  assert.equal(installed.status, 0);
  const payload = JSON.parse(installed.stdout);
  assert.equal(payload.changed, true);
  assert.equal(payload.scope, "project");
  assert.match(payload.nextAction, /\$strava-mcp-bridge/);

  const skillFile = path.join(payload.targetDir, "SKILL.md");
  assert.match(fs.readFileSync(skillFile, "utf8"), /^---\nname: strava-mcp-bridge/);

  const repeated = spawnCli([
    "skill", "install", "--project-dir", projectDir, "--json",
  ]);
  assert.equal(repeated.status, 0);
  assert.equal(JSON.parse(repeated.stdout).changed, false);

  fs.writeFileSync(skillFile, "locally modified\n");
  const blocked = spawnCli(["skill", "install", "--project-dir", projectDir]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /--force/);
  assert.equal(fs.readFileSync(skillFile, "utf8"), "locally modified\n");

  const forced = spawnCli([
    "skill", "install", "--project-dir", projectDir, "--force", "--json",
  ]);
  assert.equal(forced.status, 0);
  assert.equal(JSON.parse(forced.stdout).changed, true);
  assert.match(fs.readFileSync(skillFile, "utf8"), /^---\nname: strava-mcp-bridge/);
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
    STRAVA_MCP_ALLOW_KEYCHAIN_HELPER_OVERRIDE: "1",
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /bootstrap complete/);
  assert.doesNotMatch(result.stdout, /^null$/m);
  assert.match(result.stderr, /code: invalid-profile/);
});

test("auth status reports a classified error instead of a bare exception", () => {
  const helper = path.join(__dirname, "does-not-exist-helper");

  const helperEnv = {
    STRAVA_MCP_KEYCHAIN_HELPER: helper,
    STRAVA_MCP_ALLOW_KEYCHAIN_HELPER_OVERRIDE: "1",
  };
  const plain = spawnCli(["auth", "status"], helperEnv);
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /code: helper-missing/);

  const json = spawnCli(["auth", "status", "--json"], helperEnv);
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
    STRAVA_MCP_ALLOW_KEYCHAIN_HELPER_OVERRIDE: "1",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Do not choose "Always Allow" for \/usr\/bin\/security/);
  assert.match(result.stdout, /Claude Code-credentials/);
  assert.match(result.stderr, /helper-missing/);
});

test("custom upstream endpoint requires an explicit diagnostic override", () => {
  const rejected = spawnCli(["--endpoint", "https://example.invalid/mcp", "--auth", "env"], {
    STRAVA_MCP_ACCESS_TOKEN: "fake-token",
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /allow-endpoint-override/);

  const allowed = spawnCli([
    "--endpoint", "https://example.invalid/mcp",
    "--allow-endpoint-override",
    "--auth", "env",
  ], {
    STRAVA_MCP_ACCESS_TOKEN: "fake-token",
  });
  assert.equal(allowed.status, 0);
});

test("custom Keychain helper requires an explicit environment opt-in", () => {
  const result = spawnCli(["auth", "status"], {
    STRAVA_MCP_KEYCHAIN_HELPER: path.join(__dirname, "does-not-exist-helper"),
    STRAVA_MCP_ALLOW_KEYCHAIN_HELPER_OVERRIDE: "0",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /helper-override-disabled/);
});

test("bootstrap classifies a disabled custom helper override", () => {
  const result = spawnCli(["bootstrap", "--skip-setup", "--json"], {
    STRAVA_MCP_KEYCHAIN_HELPER: path.join(__dirname, "does-not-exist-helper"),
    STRAVA_MCP_ALLOW_KEYCHAIN_HELPER_OVERRIDE: "0",
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "helper-override-disabled");
});

test("streams prune is dry-run by default and removes only with --yes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "strava-prune-cli-"));
  const oldFile = path.join(directory, "123.json");
  const ignoredFile = path.join(directory, "notes.json");
  fs.writeFileSync(oldFile, "{}\n");
  fs.writeFileSync(ignoredFile, "{}\n");
  fs.utimesSync(oldFile, new Date(0), new Date(0));

  const dryRun = spawnCli([
    "streams", "prune", "--older-than-days", "1",
    "--stream-output-dir", directory,
    "--json",
  ]);
  assert.equal(dryRun.status, 0);
  assert.equal(JSON.parse(dryRun.stdout).dryRun, true);
  assert.equal(fs.existsSync(oldFile), true);

  const removed = spawnCli([
    "streams", "prune", "--older-than-days", "1",
    "--stream-output-dir", directory,
    "--yes", "--json",
  ]);
  assert.equal(removed.status, 0);
  assert.equal(JSON.parse(removed.stdout).dryRun, false);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(ignoredFile), true);
});

function spawnCli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

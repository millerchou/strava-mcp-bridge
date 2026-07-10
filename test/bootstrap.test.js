"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildCodexConfigToml,
  classifyBootstrapError,
  credentialState,
  keychainDialogNotice,
  refreshOrReimportCredential,
  toolsForBootstrap,
  toolsForProfile,
} = require("../src/bootstrap");

test("toolsForBootstrap prefers explicit allow tools over the profile list", () => {
  assert.deepEqual(
    toolsForBootstrap(["health", "list_activities"], "minimal"),
    ["health", "list_activities"],
  );
});

test("toolsForBootstrap falls back to profile tools when no explicit tools are given", () => {
  assert.deepEqual(toolsForBootstrap([], "minimal"), ["health", "eligibility"]);
});

test("classifyBootstrapError classifies a denied Keychain dialog", () => {
  const classified = classifyBootstrapError(new Error("SecItemCopyMatching failed (-128)"));
  assert.equal(classified.code, "keychain-access-denied");
  assert.match(classified.nextAction, /Use Allow for Claude Code-credentials/);
  assert.match(classified.nextAction, /optional only for the bridge-owned helper/);
});

test("classifyBootstrapError classifies network failures", () => {
  assert.equal(classifyBootstrapError(new TypeError("fetch failed")).code, "network-error");
  const dns = classifyBootstrapError(new Error("getaddrinfo ENOTFOUND www.strava.com"));
  assert.equal(dns.code, "network-error");
  assert.match(dns.nextAction, /network/i);
});

test("classifyBootstrapError classifies an invalid config profile", () => {
  const classified = classifyBootstrapError(new Error("Unsupported config profile: bogus"));
  assert.equal(classified.code, "invalid-profile");
  assert.match(classified.nextAction, /minimal|training-sync/);
});

test("classifyBootstrapError explains a Claude Code install with no MCP servers", () => {
  const classified = classifyBootstrapError(new Error("Claude Code credential does not contain mcpOAuth"));
  assert.equal(classified.code, "claude-code-no-mcp-servers");
  assert.match(classified.nextAction, /claude mcp add/);
});

test("classifyBootstrapError points helper build failures at Xcode Command Line Tools", () => {
  const classified = classifyBootstrapError(new Error("setup failed with exit code 1"));
  assert.equal(classified.code, "setup-build-failed");
  assert.match(classified.nextAction, /xcode-select --install/);
});

test("keychainDialogNotice distinguishes one-time import from bridge-owned access", () => {
  const notice = keychainDialogNotice({
    bridgeKeychainService: "Strava MCP Bridge Native-credentials",
    claudeCodeKeychainService: "Claude Code-credentials",
  });

  assert.match(notice, /Claude Code-credentials/);
  assert.match(notice, /Strava MCP Bridge Native-credentials/);
  assert.match(notice, /Do not choose "Always Allow" for \/usr\/bin\/security/);
  assert.match(notice, /same-user risk/);
  assert.match(notice, /upgrade/i);
  assert.doesNotMatch(notice, /accessToken|refreshToken/);
});

test("credentialState reports missing credential with actionable next step", () => {
  const state = credentialState(null);

  assert.equal(state.ok, false);
  assert.equal(state.code, "missing");
  assert.match(state.nextAction, /bootstrap/);
});

test("credentialState reports ready credential", () => {
  const state = credentialState({
    hasAccessToken: true,
    hasRefreshToken: true,
    expiresInSeconds: 7200,
  }, {
    refreshSkewSeconds: 3600,
  });

  assert.equal(state.ok, true);
  assert.equal(state.code, "ready");
});

test("credentialState reports stale refreshable credential", () => {
  const state = credentialState({
    hasAccessToken: true,
    hasRefreshToken: true,
    expiresInSeconds: -10,
  });

  assert.equal(state.ok, false);
  assert.equal(state.code, "expired-refreshable");
  assert.match(state.nextAction, /refresh/);
});

test("classifyBootstrapError gives specific Claude Code auth guidance", () => {
  const missing = classifyBootstrapError(new Error("Claude Code credential is unavailable"));
  assert.equal(missing.code, "claude-code-credential-missing");
  assert.match(missing.nextAction, /Claude Code/);

  const stale = classifyBootstrapError(
    new Error("Strava MCP OAuth refresh failed with HTTP 401: invalid_grant"),
  );
  assert.equal(stale.code, "refresh-token-stale");
  assert.match(stale.nextAction, /Re-authorize/);
});

test("toolsForProfile returns minimal and training sync allowlists", () => {
  assert.deepEqual(toolsForProfile("minimal"), [
    "health",
    "eligibility",
  ]);
  assert.deepEqual(toolsForProfile("training-sync"), [
    "health",
    "eligibility",
    "list_activities",
    "get_activity_streams",
    "get_activity_performance",
  ]);
});

test("buildCodexConfigToml renders project config without token values", () => {
  const toml = buildCodexConfigToml({
    bridgeScriptPath: "/opt/strava-mcp-bridge/bin/strava-mcp-bridge.js",
    allowTools: ["health", "eligibility"],
    streamOutputDir: "/tmp/streams",
  });

  assert.match(toml, /\[mcp_servers\.strava_bridge\]/);
  assert.match(toml, /"bridge-keychain"/);
  assert.match(toml, /"health,eligibility"/);
  assert.match(toml, /"--stream-output-dir"/);
  assert.equal(toml.includes("accessToken"), false);
  assert.equal(toml.includes("refreshToken"), false);
});

test("refreshOrReimportCredential imports fresh Claude state after stale bridge refresh", async () => {
  const calls = [];
  const action = await refreshOrReimportCredential({
    async getAccessToken(options) {
      calls.push(["refresh", options]);
      throw new Error("Strava MCP OAuth refresh failed with HTTP 401: invalid_grant");
    },
    async importFromClaudeCode(options) {
      calls.push(["import", options]);
    },
  }, {
    claimImportedCredential: true,
  });
  assert.equal(action, "reimported");
  assert.deepEqual(calls, [
    ["refresh", { forceRefresh: true }],
    ["import", { claimImportedCredential: true }],
  ]);
});

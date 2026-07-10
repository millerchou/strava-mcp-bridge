"use strict";

const { isRefreshTokenRejected } = require("./auth");

const DEFAULT_MINIMAL_TOOLS = [
  "health",
  "eligibility",
];

const TRAINING_SYNC_TOOLS = [
  "health",
  "eligibility",
  "list_activities",
  "get_activity_streams",
  "get_activity_performance",
];

function toolsForProfile(profile) {
  if (!profile || profile === "minimal") return DEFAULT_MINIMAL_TOOLS;
  if (profile === "training-sync") return TRAINING_SYNC_TOOLS;
  throw new Error(`Unsupported config profile: ${profile}`);
}

function toolsForBootstrap(allowTools, profile) {
  if (allowTools && allowTools.length) return allowTools;
  return toolsForProfile(profile);
}

function credentialState(metadata, {
  refreshSkewSeconds = 3600,
} = {}) {
  if (!metadata) {
    return {
      ok: false,
      code: "missing",
      summary: "bridge credential is not imported",
      nextAction: "Run `strava-mcp-bridge bootstrap` after Claude Code has authorized Strava MCP.",
    };
  }

  if (!metadata.hasAccessToken) {
    return {
      ok: false,
      code: "missing-access-token",
      summary: "bridge credential has no access token",
      nextAction: "Re-run `strava-mcp-bridge bootstrap` to import a complete Strava MCP credential.",
    };
  }

  if (!metadata.hasRefreshToken) {
    return {
      ok: false,
      code: "missing-refresh-token",
      summary: "bridge credential cannot refresh because it has no refresh token",
      nextAction: "Re-authorize Strava MCP in Claude Code, then run `strava-mcp-bridge bootstrap`.",
    };
  }

  if (metadata.expiresInSeconds === null || metadata.expiresInSeconds === undefined) {
    return {
      ok: true,
      code: "unknown-expiry",
      summary: "bridge credential exists; expiry is unknown, so the bridge will refresh before use",
      nextAction: "No action required unless the next MCP call fails.",
    };
  }

  if (metadata.expiresInSeconds <= 0) {
    return {
      ok: false,
      code: "expired-refreshable",
      summary: "bridge access token is expired, but a refresh token is available",
      nextAction: "Run `strava-mcp-bridge bootstrap` to refresh it now, or let the MCP call refresh on first use.",
    };
  }

  if (metadata.expiresInSeconds <= refreshSkewSeconds) {
    return {
      ok: true,
      code: "refresh-due",
      summary: "bridge access token is close to expiry; the bridge will refresh it before use",
      nextAction: "No action required.",
    };
  }

  return {
    ok: true,
    code: "ready",
    summary: "bridge credential is ready",
    nextAction: "No action required.",
  };
}

function classifyBootstrapError(error) {
  const message = error && error.message ? error.message : String(error);

  if (message.includes("Native Keychain helper not found")) {
    return {
      code: "helper-missing",
      message,
      nextAction: "Run `strava-mcp-bridge setup` and then retry.",
    };
  }

  if (message.includes("custom helper execution is disabled")) {
    return {
      code: "helper-override-disabled",
      message,
      nextAction: "Unset STRAVA_MCP_KEYCHAIN_HELPER, or explicitly set STRAVA_MCP_ALLOW_KEYCHAIN_HELPER_OVERRIDE=1 only for controlled diagnosis.",
    };
  }

  if (message.includes("timed out") && message.includes("Keychain")) {
    return {
      code: "keychain-approval-timeout",
      message,
      nextAction: "Approve the macOS Keychain prompt, then retry. Use Allow for Claude Code-credentials; Always Allow is optional only for the bridge-owned helper.",
    };
  }

  if (message.includes("Claude Code credential is unavailable")) {
    return {
      code: "claude-code-credential-missing",
      message,
      nextAction: "Open Claude Code, authorize Strava MCP from `/mcp`, then run `strava-mcp-bridge bootstrap` again.",
    };
  }

  if (message.includes("No Claude Code Strava MCP OAuth token found")) {
    return {
      code: "claude-code-strava-missing",
      message,
      nextAction: "Add the official Strava MCP to Claude Code (`claude mcp add --transport http strava https://mcp.strava.com/mcp`), authorize it from `/mcp`, then run `strava-mcp-bridge bootstrap` again.",
    };
  }

  if (message.includes("does not contain mcpOAuth")) {
    return {
      code: "claude-code-no-mcp-servers",
      message,
      nextAction: "Claude Code has no MCP servers configured yet. Add the official Strava MCP first (`claude mcp add --transport http strava https://mcp.strava.com/mcp`), authorize it from `/mcp`, then run `strava-mcp-bridge bootstrap` again.",
    };
  }

  if (message.includes("Strava MCP OAuth refresh failed with HTTP 400") ||
      message.includes("Strava MCP OAuth refresh failed with HTTP 401")) {
    return {
      code: "refresh-token-stale",
      message,
      nextAction: "The copied refresh token was rejected. Re-authorize Strava MCP in Claude Code, then run `strava-mcp-bridge bootstrap` again.",
    };
  }

  if (message.includes("cannot be refreshed without refreshToken")) {
    return {
      code: "refresh-token-missing",
      message,
      nextAction: "Re-authorize Strava MCP in Claude Code, then run `strava-mcp-bridge bootstrap` again.",
    };
  }

  if (message.includes("only supports Apple Silicon Macs")) {
    return {
      code: "unsupported-platform",
      message,
      nextAction: "Use this bridge only on Apple Silicon macOS.",
    };
  }

  if (/SecItem(CopyMatching|Add|Update|Delete) failed/.test(message)) {
    return {
      code: "keychain-access-denied",
      message,
      nextAction: "macOS Keychain refused the access request; no credential was read. Re-run in a GUI session with the login Keychain unlocked. Use Allow for Claude Code-credentials; Always Allow is optional only for the bridge-owned helper.",
    };
  }

  if (message.includes("fetch failed") ||
      /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/.test(message)) {
    return {
      code: "network-error",
      message,
      nextAction: "Check your network connection and that https://www.strava.com is reachable, then retry.",
    };
  }

  if (message.includes("Unsupported config profile")) {
    return {
      code: "invalid-profile",
      message,
      nextAction: "Use --profile minimal or --profile training-sync.",
    };
  }

  if (message.includes("setup failed with exit code")) {
    return {
      code: "setup-build-failed",
      message,
      nextAction: "Install Xcode Command Line Tools (`xcode-select --install`), review the compiler output above, then run `strava-mcp-bridge setup` again.",
    };
  }

  return {
    code: "unknown",
    message,
    nextAction: "Retry with `strava-mcp-bridge doctor --json` and inspect the non-sensitive status fields.",
  };
}

function keychainDialogNotice({
  bridgeKeychainService,
  claudeCodeKeychainService,
}) {
  return [
    "Note: macOS may show one or two Keychain permission dialogs during this step.",
    "That is Keychain access control working as intended:",
    `  - "security" wants to access "${claudeCodeKeychainService}":`,
    "    the one-time import you requested from Claude Code's credential.",
    "    Choose \"Allow\" for this prompt. Do not choose \"Always Allow\" for /usr/bin/security.",
    `  - "strava-keychain-helper" wants to access "${bridgeKeychainService}":`,
    "    the bridge reading the credential it owns.",
    "    Choose \"Allow\" for least privilege. \"Always Allow\" avoids repeat prompts,",
    "    but any process running as your macOS user can invoke this unsigned helper,",
    "    so use that convenience only if you accept the same-user risk.",
    "After an upgrade or rebuild, macOS may ask about the rebuilt helper again.",
    "Details: README, \"Why Does macOS Ask For Keychain Permission?\".",
    "",
  ].join("\n");
}

async function refreshOrReimportCredential(manager, { claimImportedCredential = true } = {}) {
  try {
    await manager.getAccessToken({ forceRefresh: true });
    return "refreshed";
  } catch (error) {
    if (!isRefreshTokenRejected(error)) throw error;
    await manager.importFromClaudeCode({ claimImportedCredential });
    return "reimported";
  }
}

function buildCodexConfigToml({
  bridgeScriptPath,
  authMode = "bridge-keychain",
  allowTools = DEFAULT_MINIMAL_TOOLS,
  streamOutputDir,
} = {}) {
  if (!bridgeScriptPath) throw new Error("bridgeScriptPath is required");
  const args = [
    bridgeScriptPath,
    "--auth",
    authMode,
    "--allow-tool",
    allowTools.join(","),
  ];

  if (streamOutputDir) {
    args.push("--stream-output-dir", streamOutputDir);
  }

  const renderedArgs = args
    .map((arg) => `  ${tomlString(arg)}`)
    .join(",\n");

  return [
    "[mcp_servers.strava_bridge]",
    "command = \"node\"",
    "args = [",
    renderedArgs,
    "]",
    "",
  ].join("\n");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

module.exports = {
  DEFAULT_MINIMAL_TOOLS,
  TRAINING_SYNC_TOOLS,
  buildCodexConfigToml,
  classifyBootstrapError,
  credentialState,
  keychainDialogNotice,
  refreshOrReimportCredential,
  toolsForBootstrap,
  toolsForProfile,
};

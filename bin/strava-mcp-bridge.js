#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { runStdioBridge } = require("../src/stdio");
const {
  CLAUDE_CODE_KEYCHAIN_SERVICE,
  DEFAULT_BRIDGE_KEYCHAIN_SERVICE,
  DEFAULT_KEYCHAIN_HELPER_TIMEOUT_MS,
  DEFAULT_OAUTH_TIMEOUT_MS,
  DEFAULT_REFRESH_SKEW_MS,
  DEFAULT_TOKEN_ENDPOINT,
  createBridgeCredentialManager,
  createTokenProvider,
  credentialMetadata,
  nativeKeychainHelperPath,
} = require("../src/auth");
const {
  DEFAULT_ENDPOINT,
  DEFAULT_PROTOCOL_VERSION,
  assertOfficialEndpoint,
} = require("../src/constants");
const { StravaMcpHttpClient } = require("../src/upstream");
const { createPolicy } = require("../src/policy");
const { defaultDataDir, expandPath, resolveDataPaths } = require("../src/paths");
const { pruneStreamFiles } = require("../src/stream_store");
const {
  buildCodexConfigToml,
  classifyBootstrapError,
  credentialState,
  keychainDialogNotice,
  refreshOrReimportCredential,
  toolsForBootstrap,
  toolsForProfile,
} = require("../src/bootstrap");

function printHelp() {
  process.stdout.write(`strava-mcp-bridge

Local stdio bridge for the official Strava MCP server.

Usage:
  strava-mcp-bridge [options]
  strava-mcp-bridge setup
  strava-mcp-bridge bootstrap [options]
  strava-mcp-bridge doctor [options]
  strava-mcp-bridge auth import [options]
  strava-mcp-bridge auth status [options]
  strava-mcp-bridge auth remove [options]
  strava-mcp-bridge config codex [options]
  strava-mcp-bridge streams prune [options]

Options:
  --endpoint <url>              Upstream MCP URL. Default: ${DEFAULT_ENDPOINT}
  --allow-endpoint-override     Allow a non-default MCP endpoint. Diagnostic only.
  --protocol-version <version>  MCP protocol version. Default: ${DEFAULT_PROTOCOL_VERSION}
  --token-endpoint <url>        OAuth token endpoint. Default: ${DEFAULT_TOKEN_ENDPOINT}
  --allow-token-endpoint-override
                                Allow a non-default token endpoint. Diagnostic only.
  --auth <mode>                 Token source: bridge-keychain, env, or
                                claude-code-keychain. Default: bridge-keychain
  --bridge-keychain-service <s> macOS Keychain service for bridge-owned
                                credentials. Default: ${DEFAULT_BRIDGE_KEYCHAIN_SERVICE}
  --refresh-skew-seconds <n>    Refresh this many seconds before expiry.
                                Default: ${Math.trunc(DEFAULT_REFRESH_SKEW_MS / 1000)}
  --oauth-timeout-ms <n>        OAuth refresh timeout in milliseconds.
                                Default: ${DEFAULT_OAUTH_TIMEOUT_MS}
  --upstream-timeout-ms <n>     Upstream MCP request timeout in milliseconds.
                                Default: 30000
  --keychain-timeout-ms <n>     Native Keychain helper timeout in milliseconds.
                                Default: ${DEFAULT_KEYCHAIN_HELPER_TIMEOUT_MS}
  --allow-tool <name[,name]>    Allow specific tools/call tool names. Repeatable.
  --data-dir <path>             Local data directory. Default:
                                ${defaultDataDir()}
  --stream-output-dir <path>    Directory for get_activity_streams files.
                                Default: <data-dir>/streams
  --json                        Print machine-readable JSON for supported
                                subcommands.
  --help                        Show this help.

Auth modes:
  env
    Read STRAVA_MCP_ACCESS_TOKEN from the environment.

  bridge-keychain
    Apple Silicon macOS-only helper. Reads and refreshes bridge-owned Strava MCP
    OAuth credentials from macOS Keychain. If missing, run
    strava-mcp-bridge auth import after Claude Code has authorized Strava MCP.
    Requires the native helper built by strava-mcp-bridge setup.

  claude-code-keychain
    Migration/diagnostic helper. Reads Claude Code's local Keychain credential
    directly and extracts the official Strava MCP OAuth access token in memory.
    It does not print or persist the token.

Default safety:
  MCP lifecycle methods, ping, cancellation/progress notifications, JSON-RPC
  responses, and tools/list are allowed.
  tools/call is blocked unless a tool name is explicitly allowed.

First-time setup:
  Run strava-mcp-bridge bootstrap after Claude Code has authorized Strava MCP.
  It builds the native helper if needed, imports the Claude Code Strava MCP
  credential into the bridge-owned Keychain item, refreshes once, and prints a
  Codex MCP config snippet.
`);
}

function printSetupHelp() {
  process.stdout.write(`strava-mcp-bridge setup

Usage:
  strava-mcp-bridge setup

Builds the native macOS Keychain helper binary (bin/strava-keychain-helper)
from native/keychain-helper.swift with swiftc. Requires Xcode Command Line
Tools. Safe to re-run; it overwrites the existing helper binary.

Options:
  --help                        Show this help.
`);
}

function printBootstrapHelp() {
  process.stdout.write(`strava-mcp-bridge bootstrap

Usage:
  strava-mcp-bridge bootstrap [options]

Imports or refreshes the bridge-owned Strava MCP credential and prints a Codex
MCP config snippet. Token values are never printed.

Options:
  --no-claim-on-import          Import without immediately refreshing.
  --claim-on-import             Explicitly refresh immediately after import.
  --skip-setup                  Do not build the native Keychain helper.
  --profile <name>              Config profile: minimal or training-sync.
                                Default: minimal
  --allow-tool <name[,name]>    Override the tool list in the generated Codex
                                snippet. Repeatable. Defaults to the --profile
                                tool list.
  --stream-output-dir <path>    Include a stream file sink in the Codex snippet.
  --json                        Print machine-readable JSON.
  --endpoint <url>              Upstream MCP URL. Default: ${DEFAULT_ENDPOINT}
  --allow-endpoint-override     Allow a non-default MCP endpoint. Diagnostic only.
  --token-endpoint <url>        OAuth token endpoint. Default: ${DEFAULT_TOKEN_ENDPOINT}
  --bridge-keychain-service <s> Bridge-owned Keychain service name.
  --keychain-timeout-ms <n>     Native Keychain helper timeout in milliseconds.
  --oauth-timeout-ms <n>        OAuth refresh timeout in milliseconds.
`);
}

function printDoctorHelp() {
  process.stdout.write(`strava-mcp-bridge doctor

Usage:
  strava-mcp-bridge doctor [options]

Runs a read-only local status check. It does not import, refresh, or modify
Claude Code, Codex, MCP config, or Keychain credentials.

Options:
  --json                        Print machine-readable JSON.
  --endpoint <url>              Upstream MCP URL. Default: ${DEFAULT_ENDPOINT}
  --allow-endpoint-override     Allow a non-default MCP endpoint. Diagnostic only.
  --bridge-keychain-service <s> Bridge-owned Keychain service name.
  --keychain-timeout-ms <n>     Native Keychain helper timeout in milliseconds.
`);
}

function printConfigHelp() {
  process.stdout.write(`strava-mcp-bridge config codex

Usage:
  strava-mcp-bridge config codex [options]

Prints a Codex MCP config snippet. It does not edit any config file.

Options:
  --profile <name>              Config profile: minimal or training-sync.
                                Default: minimal
  --allow-tool <name[,name]>    Override tools in the generated snippet.
                                Repeatable. Defaults to the --profile tool
                                list.
  --stream-output-dir <path>    Include a stream file sink.
  --auth <mode>                 Token source in the snippet. Default:
                                bridge-keychain
  --command-path <path>         Bridge JS entrypoint. Default: this script.
  --json                        Print machine-readable JSON.
`);
}

function printAuthHelp() {
  process.stdout.write(`strava-mcp-bridge auth

Usage:
  strava-mcp-bridge auth import [options]
  strava-mcp-bridge auth status [options]
  strava-mcp-bridge auth remove [options]

Commands:
  import
    Import the official Strava MCP OAuth credential from Claude Code into the
    bridge-owned Keychain item. By default this immediately refreshes once to
    claim the refresh-token chain for bridge-owned operation. Use
    --no-claim-on-import to skip that immediate refresh.

  status
    Show only non-sensitive bridge credential metadata. Token values are never
    printed.

  remove
    Delete the bridge-owned Keychain item. Without --yes it only prints the
    target item and exits without changing anything. It never touches Claude
    Code's credential. Removing when nothing is stored is a no-op.

Options:
  --yes                         Confirm removal for auth remove.
  --no-claim-on-import          Import without immediately refreshing.
  --claim-on-import             Explicitly refresh immediately after import.
  --json                        Print machine-readable JSON.
  --endpoint <url>              Upstream MCP URL. Default: ${DEFAULT_ENDPOINT}
  --allow-endpoint-override     Allow a non-default MCP endpoint. Diagnostic only.
  --token-endpoint <url>        OAuth token endpoint. Default: ${DEFAULT_TOKEN_ENDPOINT}
  --bridge-keychain-service <s> Bridge-owned Keychain service name.
  --keychain-timeout-ms <n>     Native Keychain helper timeout in milliseconds.
  --oauth-timeout-ms <n>        OAuth refresh timeout in milliseconds.
`);
}

function printStreamsHelp() {
  process.stdout.write(`strava-mcp-bridge streams prune

Usage:
  strava-mcp-bridge streams prune --older-than-days <n> [options]

Lists numeric activity stream JSON files at or older than the retention cutoff.
This is a dry run unless --yes is supplied. Symlinks and non-activity files are
never removed.

Options:
  --older-than-days <n>         Required non-negative retention age in days.
  --yes                         Remove the listed files.
  --data-dir <path>             Local data directory. Default: ${defaultDataDir()}
  --stream-output-dir <path>    Stream directory. Default: <data-dir>/streams
  --json                        Print machine-readable JSON.
  --help                        Show this help.
`);
}

function parseArgs(argv) {
  const dataPaths = resolveDataPaths({
    dataDir: process.env.STRAVA_MCP_DATA_DIR,
    streamOutputDir: process.env.STRAVA_MCP_STREAM_OUTPUT_DIR,
  });
  const config = {
    endpoint: process.env.STRAVA_MCP_URL || DEFAULT_ENDPOINT,
    protocolVersion: process.env.MCP_PROTOCOL_VERSION || DEFAULT_PROTOCOL_VERSION,
    tokenEndpoint: process.env.STRAVA_MCP_TOKEN_ENDPOINT || DEFAULT_TOKEN_ENDPOINT,
    authMode: process.env.STRAVA_MCP_AUTH || "bridge-keychain",
    bridgeKeychainService:
      process.env.STRAVA_MCP_BRIDGE_KEYCHAIN_SERVICE || DEFAULT_BRIDGE_KEYCHAIN_SERVICE,
    claimImportedCredential: process.env.STRAVA_MCP_CLAIM_ON_IMPORT === "1",
    allowTokenEndpointOverride: process.env.STRAVA_MCP_ALLOW_TOKEN_ENDPOINT_OVERRIDE === "1",
    allowEndpointOverride: process.env.STRAVA_MCP_ALLOW_ENDPOINT_OVERRIDE === "1",
    refreshSkewMs: Number(process.env.STRAVA_MCP_REFRESH_SKEW_SECONDS || "") > 0
      ? Number(process.env.STRAVA_MCP_REFRESH_SKEW_SECONDS) * 1000
      : DEFAULT_REFRESH_SKEW_MS,
    oauthTimeoutMs: positiveNumberOrDefault(
      process.env.STRAVA_MCP_OAUTH_TIMEOUT_MS,
      DEFAULT_OAUTH_TIMEOUT_MS,
    ),
    upstreamTimeoutMs: positiveNumberOrDefault(
      process.env.STRAVA_MCP_UPSTREAM_TIMEOUT_MS,
      30_000,
    ),
    keychainTimeoutMs: positiveNumberOrDefault(
      process.env.STRAVA_MCP_KEYCHAIN_TIMEOUT_MS,
      DEFAULT_KEYCHAIN_HELPER_TIMEOUT_MS,
    ),
    allowTools: parseList(process.env.STRAVA_MCP_ALLOWED_TOOLS || ""),
    dataDir: dataPaths.dataDir,
    streamOutputDir: dataPaths.streamOutputDir,
    explicitStreamOutputDir: Boolean(process.env.STRAVA_MCP_STREAM_OUTPUT_DIR),
    jsonOutput: false,
    skipSetup: false,
    yes: false,
    profile: "minimal",
    olderThanDays: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      config.help = true;
      continue;
    }
    if (arg === "--endpoint") {
      config.endpoint = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--allow-endpoint-override") {
      config.allowEndpointOverride = true;
      continue;
    }
    if (arg === "--protocol-version") {
      config.protocolVersion = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--token-endpoint") {
      config.tokenEndpoint = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--allow-token-endpoint-override") {
      config.allowTokenEndpointOverride = true;
      continue;
    }
    if (arg === "--auth") {
      config.authMode = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--bridge-keychain-service") {
      config.bridgeKeychainService = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--refresh-skew-seconds") {
      const seconds = Number(requireValue(argv, ++i, arg));
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`${arg} must be a non-negative number`);
      }
      config.refreshSkewMs = seconds * 1000;
      continue;
    }
    if (arg === "--claim-on-import") {
      config.claimImportedCredential = true;
      continue;
    }
    if (arg === "--no-claim-on-import") {
      config.claimImportedCredential = false;
      continue;
    }
    if (arg === "--oauth-timeout-ms") {
      config.oauthTimeoutMs = requirePositiveNumber(argv, ++i, arg);
      continue;
    }
    if (arg === "--upstream-timeout-ms") {
      config.upstreamTimeoutMs = requirePositiveNumber(argv, ++i, arg);
      continue;
    }
    if (arg === "--keychain-timeout-ms") {
      config.keychainTimeoutMs = requirePositiveNumber(argv, ++i, arg);
      continue;
    }
    if (arg === "--allow-tool") {
      config.allowTools.push(...parseList(requireValue(argv, ++i, arg)));
      continue;
    }
    if (arg === "--data-dir") {
      config.dataDir = expandPath(requireValue(argv, ++i, arg));
      if (!config.explicitStreamOutputDir) {
        config.streamOutputDir = path.join(config.dataDir, "streams");
      }
      continue;
    }
    if (arg === "--stream-output-dir") {
      config.streamOutputDir = expandPath(requireValue(argv, ++i, arg));
      config.explicitStreamOutputDir = true;
      continue;
    }
    if (arg === "--json") {
      config.jsonOutput = true;
      continue;
    }
    if (arg === "--yes") {
      config.yes = true;
      continue;
    }
    if (arg === "--skip-setup") {
      config.skipSetup = true;
      continue;
    }
    if (arg === "--profile") {
      config.profile = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--older-than-days") {
      const days = Number(requireValue(argv, ++i, arg));
      if (!Number.isFinite(days) || days < 0) {
        throw new Error(`${arg} must be a non-negative number`);
      }
      config.olderThanDays = days;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  config.allowTools = Array.from(new Set(config.allowTools));
  return config;
}

function requireValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function requirePositiveNumber(argv, index, optionName) {
  const value = Number(requireValue(argv, index, optionName));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${optionName} must be a positive number`);
  }
  return value;
}

function positiveNumberOrDefault(value, defaultValue) {
  const parsed = Number(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "setup") {
    if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
      printSetupHelp();
      return;
    }
    runSetup();
    return;
  }
  if (argv[0] === "bootstrap") {
    await runBootstrapCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "doctor") {
    runDoctorCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "auth") {
    await runAuthCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "config") {
    runConfigCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "streams") {
    runStreamsCommand(argv.slice(1));
    return;
  }

  const config = parseArgs(argv);
  if (config.help) {
    printHelp();
    return;
  }

  configureKeychainTimeout(config.keychainTimeoutMs);
  assertConfiguredEndpoint(config);

  const tokenProvider = createTokenProvider({
    mode: config.authMode,
    endpoint: config.endpoint,
    tokenEndpoint: config.tokenEndpoint,
    bridgeKeychainService: config.bridgeKeychainService,
    refreshSkewMs: config.refreshSkewMs,
    claimImportedCredential: config.claimImportedCredential,
    allowTokenEndpointOverride: config.allowTokenEndpointOverride,
    oauthTimeoutMs: config.oauthTimeoutMs,
  });

  const upstream = new StravaMcpHttpClient({
    endpoint: config.endpoint,
    protocolVersion: config.protocolVersion,
    tokenProvider,
    requestTimeoutMs: config.upstreamTimeoutMs,
    allowEndpointOverride: config.allowEndpointOverride,
  });

  const policy = createPolicy({
    allowTools: config.allowTools,
  });

  await runStdioBridge({
    input: process.stdin,
    output: process.stdout,
    upstream,
    policy,
    streamOutputDir: config.streamOutputDir,
  });
}

async function runBootstrapCommand(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    printBootstrapHelp();
    return;
  }

  const config = parseArgs(argv);
  if (config.help) {
    printBootstrapHelp();
    return;
  }

  configureKeychainTimeout(config.keychainTimeoutMs);
  assertConfiguredEndpoint(config);

  if (!config.jsonOutput) {
    process.stdout.write(keychainDialogNotice({
      bridgeKeychainService: config.bridgeKeychainService,
      claudeCodeKeychainService: CLAUDE_CODE_KEYCHAIN_SERVICE,
    }));
    process.stdout.write("\n");
  }

  const result = {
    ok: false,
    helper: { path: null, found: false },
    credential: null,
    state: null,
    action: "none",
    codexConfig: null,
    error: null,
  };

  try {
    const bootstrapAllowTools = toolsForBootstrap(config.allowTools, config.profile);
    result.helper = inspectNativeHelper();

    if (!config.skipSetup && !result.helper.found) {
      runSetup();
      result.helper = inspectNativeHelper();
    }

    const manager = createManager(config);
    let metadata = manager.readBridgeCredentialMetadata();
    let state = credentialState(metadata, {
      refreshSkewSeconds: Math.trunc(config.refreshSkewMs / 1000),
    });

    if (!metadata || state.code === "missing-access-token" || state.code === "missing-refresh-token") {
      const credential = await manager.importFromClaudeCode({
        claimImportedCredential: shouldClaimDuringImport(argv),
      });
      metadata = credentialMetadata(credential);
      state = credentialState(metadata, {
        refreshSkewSeconds: Math.trunc(config.refreshSkewMs / 1000),
      });
      result.action = "imported";
    } else if (state.code === "expired-refreshable" ||
        state.code === "refresh-due" ||
        state.code === "unknown-expiry") {
      result.action = await refreshOrReimportCredential(manager, {
        claimImportedCredential: shouldClaimDuringImport(argv),
      });
      metadata = manager.readBridgeCredentialMetadata();
      state = credentialState(metadata, {
        refreshSkewSeconds: Math.trunc(config.refreshSkewMs / 1000),
      });
    } else {
      result.action = "already-ready";
    }

    result.credential = metadata;
    result.state = state;
    result.codexConfig = buildCodexConfigToml({
      bridgeScriptPath: currentBridgeScriptPath(),
      authMode: "bridge-keychain",
      allowTools: bootstrapAllowTools,
      streamOutputDir: config.explicitStreamOutputDir ? config.streamOutputDir : undefined,
    });
    result.ok = true;
    printBootstrapResult(result, config);
  } catch (error) {
    result.error = classifyBootstrapError(error);
    printBootstrapResult(result, config);
    process.exitCode = 1;
  }
}

function runDoctorCommand(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    printDoctorHelp();
    return;
  }

  const config = parseArgs(argv);
  if (config.help) {
    printDoctorHelp();
    return;
  }
  configureKeychainTimeout(config.keychainTimeoutMs);
  assertConfiguredEndpoint(config);

  const result = {
    ok: false,
    platform: {
      platform: process.platform,
      arch: process.arch,
      supported: process.platform === "darwin" && process.arch === "arm64",
    },
    helper: { path: null, found: false },
    credential: null,
    state: null,
    error: null,
  };

  try {
    result.helper = inspectNativeHelper();
    const manager = createManager(config);
    const metadata = manager.readBridgeCredentialMetadata();
    const state = credentialState(metadata, {
      refreshSkewSeconds: Math.trunc(config.refreshSkewMs / 1000),
    });
    result.ok = result.platform.supported && result.helper.found && state.ok;
    result.credential = metadata;
    result.state = state;
  } catch (error) {
    result.error = classifyBootstrapError(error);
  }

  printDoctorResult(result, config);
  if (!result.ok) process.exitCode = 1;
}

function runConfigCommand(argv) {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    printConfigHelp();
    return;
  }
  if (command !== "codex") {
    throw new Error(`Unknown config command: ${command}`);
  }

  const config = parseConfigCodexArgs(argv.slice(1));
  if (config.help) {
    printConfigHelp();
    return;
  }

  const toml = buildCodexConfigToml({
    bridgeScriptPath: config.commandPath,
    authMode: config.authMode,
    allowTools: config.allowTools,
    streamOutputDir: config.streamOutputDir,
  });

  if (config.jsonOutput) {
    process.stdout.write(`${JSON.stringify({
      command: "codex",
      profile: config.profile,
      allowTools: config.allowTools,
      streamOutputDir: config.streamOutputDir || null,
      toml,
    }, null, 2)}\n`);
    return;
  }

  process.stdout.write(toml);
}

async function runAuthCommand(argv) {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    printAuthHelp();
    return;
  }

  const config = parseArgs(argv.slice(1));
  if (config.help) {
    printAuthHelp();
    return;
  }

  if (command === "remove") {
    runAuthRemove(config);
    return;
  }

  configureKeychainTimeout(config.keychainTimeoutMs);

  if (command === "import") {
    try {
      assertConfiguredEndpoint(config);
      const manager = createManager(config);
      const credential = await manager.importFromClaudeCode({
        claimImportedCredential: shouldClaimDuringImport(argv),
      });
      printCredentialMetadata({
        found: true,
        action: "imported",
        metadata: credentialMetadata(credential),
      }, config);
    } catch (error) {
      printAuthFailure("import", error, config);
    }
    return;
  }

  if (command === "status") {
    try {
      assertConfiguredEndpoint(config);
      const manager = createManager(config);
      const metadata = manager.readBridgeCredentialMetadata();
      printCredentialMetadata({
        found: Boolean(metadata),
        action: "status",
        metadata,
      }, config);
      if (!metadata) process.exitCode = 1;
    } catch (error) {
      printAuthFailure("status", error, config);
    }
    return;
  }

  throw new Error(`Unknown auth command: ${command}`);
}

function printAuthFailure(command, error, config) {
  const classified = classifyBootstrapError(error);
  if (config.jsonOutput) {
    process.stdout.write(`${JSON.stringify({
      command,
      ok: false,
      error: classified,
    }, null, 2)}\n`);
  } else {
    process.stderr.write(`strava-mcp-bridge auth ${command} failed\n`);
    process.stderr.write(`reason: ${classified.message}\n`);
    process.stderr.write(`code: ${classified.code}\n`);
    process.stderr.write(`next: ${classified.nextAction}\n`);
  }
  process.exitCode = 1;
}

function runAuthRemove(config) {
  const service = config.bridgeKeychainService;

  if (!config.yes) {
    if (config.jsonOutput) {
      process.stdout.write(`${JSON.stringify({
        command: "remove",
        service,
        removed: false,
        dryRun: true,
        nextAction: "Re-run with --yes to remove it.",
      }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Would remove Keychain item: ${service}\n`);
    process.stdout.write("Re-run with --yes to actually remove it.\n");
    return;
  }

  configureKeychainTimeout(config.keychainTimeoutMs);
  try {
    const manager = createManager(config);
    const result = manager.removeBridgeCredential();

    if (config.jsonOutput) {
      process.stdout.write(`${JSON.stringify({
        command: "remove",
        service,
        removed: result.removed,
      }, null, 2)}\n`);
      return;
    }

    process.stdout.write(result.removed
      ? `Removed Keychain item: ${service}\n`
      : `Nothing to remove (no bridge credential found): ${service}\n`);
  } catch (error) {
    printAuthFailure("remove", error, config);
  }
}

function runStreamsCommand(argv) {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    printStreamsHelp();
    return;
  }
  if (command !== "prune") {
    throw new Error(`Unknown streams command: ${command}`);
  }

  const config = parseArgs(argv.slice(1));
  if (config.help) {
    printStreamsHelp();
    return;
  }
  if (config.olderThanDays === null) {
    throw new Error("streams prune requires --older-than-days");
  }

  const result = pruneStreamFiles({
    directory: config.streamOutputDir,
    olderThanDays: config.olderThanDays,
    remove: config.yes,
  });
  if (config.jsonOutput) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${result.dryRun ? "Would remove" : "Removed"} ${result.files.length} stream file(s) from ${result.directory}\n`);
  for (const file of result.files) process.stdout.write(`${file}\n`);
  if (result.dryRun) process.stdout.write("Re-run with --yes to remove them.\n");
}

function createManager(config) {
  return createBridgeCredentialManager({
    endpoint: config.endpoint,
    tokenEndpoint: config.tokenEndpoint,
    bridgeKeychainService: config.bridgeKeychainService,
    refreshSkewMs: config.refreshSkewMs,
    claimImportedCredential: config.claimImportedCredential,
    allowTokenEndpointOverride: config.allowTokenEndpointOverride,
    oauthTimeoutMs: config.oauthTimeoutMs,
  });
}

function shouldClaimDuringImport(argv) {
  if (argv.includes("--no-claim-on-import")) return false;
  if (argv.includes("--claim-on-import")) return true;
  if (process.env.STRAVA_MCP_NO_CLAIM_ON_IMPORT === "1") return false;
  return true;
}

function parseConfigCodexArgs(argv) {
  const config = {
    profile: "minimal",
    allowTools: null,
    authMode: "bridge-keychain",
    commandPath: currentBridgeScriptPath(),
    streamOutputDir: "",
    jsonOutput: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      config.help = true;
      continue;
    }
    if (arg === "--profile") {
      config.profile = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--allow-tool") {
      config.allowTools = (config.allowTools || []).concat(parseList(requireValue(argv, ++i, arg)));
      continue;
    }
    if (arg === "--stream-output-dir") {
      config.streamOutputDir = expandPath(requireValue(argv, ++i, arg));
      continue;
    }
    if (arg === "--auth") {
      config.authMode = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--command-path") {
      config.commandPath = expandPath(requireValue(argv, ++i, arg));
      continue;
    }
    if (arg === "--json") {
      config.jsonOutput = true;
      continue;
    }
    throw new Error(`Unknown config codex option: ${arg}`);
  }

  if (config.help) return config;

  config.allowTools = config.allowTools
    ? Array.from(new Set(config.allowTools))
    : toolsForProfile(config.profile);
  return config;
}

function inspectNativeHelper() {
  const helperPath = nativeHelperPath();
  return {
    path: helperPath,
    found: fs.existsSync(helperPath),
  };
}

function nativeHelperPath() {
  return nativeKeychainHelperPath();
}

function assertConfiguredEndpoint(config) {
  assertOfficialEndpoint(config.endpoint, {
    allowOverride: config.allowEndpointOverride,
  });
}

function currentBridgeScriptPath() {
  return path.resolve(__filename);
}

function printBootstrapResult(result, config) {
  if (config.jsonOutput) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (!result.ok) {
    process.stderr.write("Strava MCP bridge bootstrap failed\n");
    if (result.error) {
      process.stderr.write(`reason: ${result.error.message}\n`);
      process.stderr.write(`code: ${result.error.code}\n`);
      process.stderr.write(`next: ${result.error.nextAction}\n`);
    }
    return;
  }

  process.stdout.write("Strava MCP bridge bootstrap complete\n");
  process.stdout.write(`action: ${result.action}\n`);
  printHelperSummary(result.helper);
  printCredentialSummary(result.credential, result.state);
  process.stdout.write("\nCodex project config example (add it to the target project's .codex/config.toml):\n");
  process.stdout.write(result.codexConfig);
}

function printDoctorResult(result, config) {
  if (config.jsonOutput) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write("Strava MCP bridge doctor\n");
  process.stdout.write(`platform: ${result.platform.platform}/${result.platform.arch}`);
  process.stdout.write(result.platform.supported ? " (supported)\n" : " (unsupported)\n");
  printHelperSummary(result.helper);

  if (result.error) {
    process.stdout.write(`status: ${result.error.code}\n`);
    process.stdout.write(`reason: ${result.error.message}\n`);
    process.stdout.write(`next: ${result.error.nextAction}\n`);
    return;
  }

  printCredentialSummary(result.credential, result.state);
}

function printHelperSummary(helper) {
  process.stdout.write(`nativeHelper: ${helper.found ? "found" : "missing"}\n`);
  process.stdout.write(`nativeHelperPath: ${helper.path}\n`);
}

function printCredentialSummary(metadata, state) {
  process.stdout.write(`credential: ${state ? state.code : "unknown"}\n`);
  if (state) {
    process.stdout.write(`summary: ${state.summary}\n`);
    process.stdout.write(`next: ${state.nextAction}\n`);
  }
  if (!metadata) return;

  process.stdout.write(`serverUrl: ${metadata.serverUrl}\n`);
  process.stdout.write(`tokenEndpoint: ${metadata.tokenEndpoint || ""}\n`);
  process.stdout.write(`scope: ${metadata.scope || ""}\n`);
  process.stdout.write(`tokenType: ${metadata.tokenType || ""}\n`);
  process.stdout.write(`expiresAtUtc: ${metadata.expiresAtUtc || ""}\n`);
  process.stdout.write(`expiresAtLocal: ${metadata.expiresAt ? new Date(metadata.expiresAt).toLocaleString() : ""}\n`);
  process.stdout.write(`expiresInSeconds: ${metadata.expiresInSeconds ?? ""}\n`);
  process.stdout.write(`hasAccessToken: ${metadata.hasAccessToken}\n`);
  process.stdout.write(`hasRefreshToken: ${metadata.hasRefreshToken}\n`);
  process.stdout.write(`source: ${metadata.source || ""}\n`);
}

function runSetup() {
  const script = path.join(__dirname, "..", "scripts", "build-keychain-helper.sh");
  const result = spawnSync("sh", [script], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`setup failed with exit code ${result.status}`);
  }
}

function configureKeychainTimeout(timeoutMs) {
  process.env.STRAVA_MCP_KEYCHAIN_TIMEOUT_MS = String(timeoutMs);
}

function printCredentialMetadata(payload, config) {
  if (config.jsonOutput) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (!payload.found) {
    process.stdout.write("Bridge credential: not found\n");
    return;
  }

  const metadata = payload.metadata;
  process.stdout.write(`Bridge credential: ${payload.action}\n`);
  process.stdout.write(`serverUrl: ${metadata.serverUrl}\n`);
  process.stdout.write(`tokenEndpoint: ${metadata.tokenEndpoint}\n`);
  process.stdout.write(`scope: ${metadata.scope || ""}\n`);
  process.stdout.write(`tokenType: ${metadata.tokenType || ""}\n`);
  process.stdout.write(`expiresAt: ${metadata.expiresAt || ""}\n`);
  process.stdout.write(`expiresAtUtc: ${metadata.expiresAtUtc || ""}\n`);
  process.stdout.write(`expiresAtLocal: ${metadata.expiresAt ? new Date(metadata.expiresAt).toLocaleString() : ""}\n`);
  process.stdout.write(`expiresInSeconds: ${metadata.expiresInSeconds ?? ""}\n`);
  process.stdout.write(`hasAccessToken: ${metadata.hasAccessToken}\n`);
  process.stdout.write(`hasRefreshToken: ${metadata.hasRefreshToken}\n`);
  process.stdout.write(`source: ${metadata.source || ""}\n`);
}

main().catch((error) => {
  process.stderr.write(`strava-mcp-bridge: ${error.message}\n`);
  process.exit(1);
});

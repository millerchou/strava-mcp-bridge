"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const DEFAULT_BRIDGE_KEYCHAIN_SERVICE = "Strava MCP Bridge Native-credentials";
const DEFAULT_TOKEN_ENDPOINT = "https://www.strava.com/oauth/mcp/token";
const DEFAULT_REFRESH_SKEW_MS = 60 * 60 * 1000;
const DEFAULT_KEYCHAIN_HELPER_TIMEOUT_MS = 120_000;
const DEFAULT_OAUTH_TIMEOUT_MS = 30_000;

function createTokenProvider({
  mode,
  endpoint,
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
  bridgeKeychainService = DEFAULT_BRIDGE_KEYCHAIN_SERVICE,
  refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
  claimImportedCredential = true,
  allowTokenEndpointOverride = false,
  oauthTimeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (mode === "env") {
    assertSupportedPlatform();
    return async () => {
      const token = process.env.STRAVA_MCP_ACCESS_TOKEN;
      if (!token) {
        throw new Error("STRAVA_MCP_ACCESS_TOKEN is required when --auth env is used");
      }
      return token;
    };
  }

  if (mode === "claude-code-keychain") {
    assertSupportedPlatform();
    let cachedCredential = null;
    return async ({ forceRefresh = false } = {}) => {
      if (!cachedCredential || forceRefresh) {
        cachedCredential = readClaudeCodeKeychainStravaCredential({
          endpoint,
          tokenEndpoint,
          allowTokenEndpointOverride,
        });
      }
      return cachedCredential.accessToken;
    };
  }

  if (mode === "bridge-keychain") {
    const manager = createBridgeCredentialManager({
      endpoint,
      tokenEndpoint,
      refreshSkewMs,
      claimImportedCredential,
      allowClaudeCodeImport: false,
      allowTokenEndpointOverride,
      oauthTimeoutMs,
      fetchImpl,
      bridgeKeychainService,
    });

    return async ({ forceRefresh = false } = {}) => {
      return manager.getAccessToken({ forceRefresh });
    };
  }

  throw new Error(`Unsupported auth mode: ${mode}`);
}

function createBridgeCredentialManager({
  endpoint,
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
  bridgeKeychainService = DEFAULT_BRIDGE_KEYCHAIN_SERVICE,
  refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
  claimImportedCredential = true,
  allowClaudeCodeImport = false,
  allowTokenEndpointOverride = false,
  oauthTimeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  assertSupportedPlatform();
  return new BridgeCredentialManager({
    endpoint,
    tokenEndpoint,
    refreshSkewMs,
    claimImportedCredential,
    allowClaudeCodeImport,
    allowTokenEndpointOverride,
    oauthTimeoutMs,
    fetchImpl,
    now,
    bridgeKeychainStore: createMacOsKeychainStore({
      service: bridgeKeychainService,
      account: os.userInfo().username,
    }),
    claudeCodeKeychainStore: createSecurityCliKeychainStore({
      service: CLAUDE_CODE_KEYCHAIN_SERVICE,
      account: os.userInfo().username,
    }),
  });
}

class BridgeCredentialManager {
  constructor({
    endpoint,
    tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
    refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
    claimImportedCredential = true,
    allowClaudeCodeImport = false,
    allowTokenEndpointOverride = false,
    oauthTimeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
    bridgeKeychainStore,
    claudeCodeKeychainStore,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  }) {
    if (!endpoint) throw new Error("endpoint is required");
    if (!tokenEndpoint) throw new Error("tokenEndpoint is required");
    if (!bridgeKeychainStore) throw new Error("bridgeKeychainStore is required");
    if (!claudeCodeKeychainStore) throw new Error("claudeCodeKeychainStore is required");
    if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

    this.endpoint = endpoint;
    this.tokenEndpoint = tokenEndpoint;
    this.refreshSkewMs = refreshSkewMs;
    this.claimImportedCredential = claimImportedCredential;
    this.allowClaudeCodeImport = allowClaudeCodeImport;
    this.allowTokenEndpointOverride = allowTokenEndpointOverride;
    this.oauthTimeoutMs = oauthTimeoutMs;
    this.bridgeKeychainStore = bridgeKeychainStore;
    this.claudeCodeKeychainStore = claudeCodeKeychainStore;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cachedCredential = null;
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    let credential = this.cachedCredential || this.readBridgeCredential();

    if (!credential) {
      if (!this.allowClaudeCodeImport) {
        throw new Error(
          "Bridge credential not found. Run `strava-mcp-bridge auth import` after authorizing Strava MCP in Claude Code.",
        );
      }
      credential = this.importFromClaudeCodeCredential();
      this.writeBridgeCredential(credential);
    }

    if (forceRefresh || shouldClaimImportedCredential(credential, {
      claimImportedCredential: this.claimImportedCredential,
    }) || shouldRefreshCredential(credential, {
      nowMs: this.now(),
      refreshSkewMs: this.refreshSkewMs,
    })) {
      credential = await this.refreshCredentialWithKeychainRetry(credential);
      this.writeBridgeCredential(credential);
    }

    if (!credential.accessToken) {
      throw new Error("Bridge Strava MCP credential does not contain an access token");
    }

    this.cachedCredential = credential;
    return credential.accessToken;
  }

  async importFromClaudeCode({ claimImportedCredential = this.claimImportedCredential } = {}) {
    let credential = this.importFromClaudeCodeCredential();
    if (shouldClaimImportedCredential(credential, { claimImportedCredential })) {
      credential = await this.refreshCredentialWithKeychainRetry(credential, {
        retryFromKeychain: false,
      });
    }

    this.writeBridgeCredential(credential);
    return credential;
  }

  readBridgeCredential() {
    const raw = this.bridgeKeychainStore.read();
    if (!raw) return null;
    return parseBridgeCredential(raw, {
      endpoint: this.endpoint,
      tokenEndpoint: this.tokenEndpoint,
      allowTokenEndpointOverride: this.allowTokenEndpointOverride,
    });
  }

  readBridgeCredentialMetadata() {
    const credential = this.readBridgeCredential();
    if (!credential) return null;
    return credentialMetadata(credential, { nowMs: this.now() });
  }

  writeBridgeCredential(credential) {
    this.bridgeKeychainStore.write(JSON.stringify(toStoredBridgeCredential(credential)));
    this.cachedCredential = credential;
  }

  removeBridgeCredential() {
    const result = this.bridgeKeychainStore.delete();
    this.cachedCredential = null;
    return { removed: Boolean(result && result.removed) };
  }

  importFromClaudeCodeCredential() {
    const raw = this.claudeCodeKeychainStore.read();
    if (!raw) {
      throw new Error("Bridge credential not found and Claude Code credential is unavailable");
    }
    return parseClaudeCodeCredentialForStravaCredential(raw, {
      endpoint: this.endpoint,
      tokenEndpoint: this.tokenEndpoint,
      allowTokenEndpointOverride: this.allowTokenEndpointOverride,
    });
  }

  async refreshCredentialWithKeychainRetry(credential, {
    retryFromKeychain = true,
  } = {}) {
    try {
      return await this.refreshCredential(credential);
    } catch (error) {
      if (!retryFromKeychain || !isRefreshTokenRejected(error)) {
        throw error;
      }

      const latest = this.readBridgeCredential();
      if (!latest || latest.refreshToken === credential.refreshToken) {
        throw error;
      }

      if (latest.accessToken && !shouldRefreshCredential(latest, {
        nowMs: this.now(),
        refreshSkewMs: this.refreshSkewMs,
      })) {
        return latest;
      }

      return this.refreshCredential(latest);
    }
  }

  async refreshCredential(credential) {
    if (!credential.refreshToken) {
      throw new Error("Bridge Strava MCP credential cannot be refreshed without refreshToken");
    }
    if (!credential.clientId) {
      throw new Error("Bridge Strava MCP credential cannot be refreshed without clientId");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
    });

    const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: body.toString(),
    };
    const signal = createTimeoutSignal(this.oauthTimeoutMs);
    if (signal) requestOptions.signal = signal;

    const response = await this.fetchImpl(credential.tokenEndpoint || this.tokenEndpoint, requestOptions);

    const bodyText = await response.text();
    let parsed = {};
    if (bodyText.trim()) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new Error(`Strava MCP OAuth refresh returned non-JSON response: HTTP ${response.status}`);
      }
    }

    if (!response.ok) {
      const errorName = typeof parsed.error === "string" ? `: ${parsed.error}` : "";
      throw new Error(`Strava MCP OAuth refresh failed with HTTP ${response.status}${errorName}`);
    }

    const accessToken = parsed.access_token || parsed.accessToken;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error("Strava MCP OAuth refresh response did not include access_token");
    }

    return normalizeCredential({
      ...credential,
      accessToken,
      refreshToken: parsed.refresh_token || parsed.refreshToken || credential.refreshToken,
      expiresAt: parseRefreshExpiresAt(parsed, this.now()),
      scope: parsed.scope || credential.scope || null,
      tokenType: parsed.token_type || parsed.tokenType || credential.tokenType || null,
      updatedAt: new Date(this.now()).toISOString(),
      source: "strava-mcp-bridge",
    }, {
      endpoint: this.endpoint,
      tokenEndpoint: credential.tokenEndpoint || this.tokenEndpoint,
      allowTokenEndpointOverride: this.allowTokenEndpointOverride,
    });
  }
}

function readClaudeCodeKeychainStravaToken({
  endpoint,
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
  allowTokenEndpointOverride = false,
}) {
  return readClaudeCodeKeychainStravaCredential({
    endpoint,
    tokenEndpoint,
    allowTokenEndpointOverride,
  }).accessToken;
}

function readClaudeCodeKeychainStravaCredential({
  endpoint,
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
  allowTokenEndpointOverride = false,
}) {
  if (process.platform !== "darwin") {
    throw new Error("--auth claude-code-keychain is only supported on macOS");
  }

  const raw = createSecurityCliKeychainStore({
    service: CLAUDE_CODE_KEYCHAIN_SERVICE,
    account: os.userInfo().username,
  }).read();

  if (!raw) {
    throw new Error("Claude Code credential is unavailable");
  }
  return parseClaudeCodeCredentialForStravaCredential(raw, {
    endpoint,
    tokenEndpoint,
    allowTokenEndpointOverride,
  });
}

function parseClaudeCodeCredentialForStravaToken(rawCredentialJson, { endpoint }) {
  return parseClaudeCodeCredentialForStravaCredential(rawCredentialJson, {
    endpoint,
    tokenEndpoint: DEFAULT_TOKEN_ENDPOINT,
  }).accessToken;
}

function parseClaudeCodeCredentialForStravaCredential(
  rawCredentialJson,
  {
    endpoint,
    tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
    allowTokenEndpointOverride = false,
  },
) {
  const parsed = parseCredentialJson(rawCredentialJson, "Claude Code credential");
  const mcpOAuth = parsed.mcpOAuth;
  if (!mcpOAuth || typeof mcpOAuth !== "object") {
    throw new Error("Claude Code credential does not contain mcpOAuth");
  }

  const entryKey = Object.keys(mcpOAuth).find((key) => {
    const entry = mcpOAuth[key];
    return (
      key.startsWith("strava|") &&
      entry &&
      entry.serverUrl === endpoint &&
      typeof entry.accessToken === "string" &&
      entry.accessToken.length > 0
    );
  });

  if (!entryKey) {
    throw new Error(`No Claude Code Strava MCP OAuth token found for ${endpoint}`);
  }

  const entry = mcpOAuth[entryKey];
  const entryTokenEndpoint = findTokenEndpoint(entry) || tokenEndpoint;
  return normalizeCredential({
    schemaVersion: 1,
    serverName: entry.serverName || "strava",
    serverUrl: entry.serverUrl,
    tokenEndpoint: entryTokenEndpoint,
    clientId: entry.clientId || null,
    redirectUri: entry.redirectUri || null,
    scope: entry.scope || null,
    tokenType: entry.tokenType || entry.token_type || null,
    accessToken: entry.accessToken,
    refreshToken: entry.refreshToken || null,
    expiresAt: entry.expiresAt ?? null,
    importedAt: new Date().toISOString(),
    source: "claude-code-keychain",
  }, { endpoint, tokenEndpoint, allowTokenEndpointOverride });
}

function parseBridgeCredential(rawCredentialJson, {
  endpoint,
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
  allowTokenEndpointOverride = false,
}) {
  const parsed = parseCredentialJson(rawCredentialJson, "Bridge Strava MCP credential");
  return normalizeCredential(parsed, {
    endpoint,
    tokenEndpoint,
    allowTokenEndpointOverride,
  });
}

function parseCredentialJson(rawCredentialJson, label) {
  try {
    return JSON.parse(rawCredentialJson);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function normalizeCredential(credential, {
  endpoint,
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
  allowTokenEndpointOverride = false,
}) {
  if (!credential || typeof credential !== "object") {
    throw new Error("Strava MCP credential must be an object");
  }
  if (credential.serverUrl !== endpoint) {
    throw new Error(`Strava MCP credential is for ${credential.serverUrl || "unknown endpoint"}, not ${endpoint}`);
  }
  if (typeof credential.accessToken !== "string" || !credential.accessToken) {
    throw new Error("Strava MCP credential does not contain accessToken");
  }

  return {
    schemaVersion: 1,
    serverName: credential.serverName || "strava",
    serverUrl: credential.serverUrl,
    tokenEndpoint: normalizeTokenEndpoint(credential.tokenEndpoint || tokenEndpoint, {
      allowTokenEndpointOverride,
    }),
    clientId: credential.clientId || null,
    redirectUri: credential.redirectUri || null,
    scope: credential.scope || null,
    tokenType: credential.tokenType || credential.token_type || null,
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken || null,
    expiresAt: normalizeExpiresAt(credential.expiresAt ?? credential.expires_at ?? null),
    importedAt: credential.importedAt || null,
    updatedAt: credential.updatedAt || null,
    source: credential.source || null,
  };
}

function normalizeTokenEndpoint(tokenEndpoint, { allowTokenEndpointOverride = false } = {}) {
  if (typeof tokenEndpoint !== "string" || !tokenEndpoint) {
    throw new Error("Strava MCP credential does not contain tokenEndpoint");
  }
  if (!allowTokenEndpointOverride && tokenEndpoint !== DEFAULT_TOKEN_ENDPOINT) {
    throw new Error(
      `Unsupported Strava MCP OAuth token endpoint: ${tokenEndpoint}. ` +
      `Expected ${DEFAULT_TOKEN_ENDPOINT}. Use --allow-token-endpoint-override only for controlled diagnosis.`,
    );
  }
  return tokenEndpoint;
}

function credentialMetadata(credential, { nowMs = Date.now() } = {}) {
  return {
    schemaVersion: credential.schemaVersion,
    serverName: credential.serverName,
    serverUrl: credential.serverUrl,
    tokenEndpoint: credential.tokenEndpoint,
    clientId: credential.clientId || null,
    redirectUri: credential.redirectUri || null,
    scope: credential.scope || null,
    tokenType: credential.tokenType || null,
    expiresAt: credential.expiresAt || null,
    expiresAtUtc: credential.expiresAt ? new Date(credential.expiresAt).toISOString() : null,
    expiresInSeconds: credential.expiresAt ? Math.trunc((credential.expiresAt - nowMs) / 1000) : null,
    hasAccessToken: Boolean(credential.accessToken),
    hasRefreshToken: Boolean(credential.refreshToken),
    importedAt: credential.importedAt || null,
    updatedAt: credential.updatedAt || null,
    source: credential.source || null,
  };
}

function toStoredBridgeCredential(credential) {
  return Object.fromEntries(
    Object.entries({
      schemaVersion: credential.schemaVersion,
      serverName: credential.serverName,
      serverUrl: credential.serverUrl,
      tokenEndpoint: credential.tokenEndpoint,
      clientId: credential.clientId,
      redirectUri: credential.redirectUri,
      scope: credential.scope,
      tokenType: credential.tokenType,
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresAt,
      importedAt: credential.importedAt,
      updatedAt: credential.updatedAt,
      source: credential.source,
    }).filter(([, value]) => value !== undefined),
  );
}

function normalizeExpiresAt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  if (/^\d+$/.test(String(value))) {
    const numeric = Number(value);
    return numeric > 1e12 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
  }

  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid Strava MCP credential expiresAt: ${value}`);
  }
  return parsed;
}

function parseRefreshExpiresAt(responseJson, nowMs) {
  if (responseJson.expires_at !== undefined) return normalizeExpiresAt(responseJson.expires_at);
  if (responseJson.expiresAt !== undefined) return normalizeExpiresAt(responseJson.expiresAt);
  if (responseJson.expires_in !== undefined) return nowMs + Number(responseJson.expires_in) * 1000;
  if (responseJson.expiresIn !== undefined) return nowMs + Number(responseJson.expiresIn) * 1000;
  return null;
}

function shouldRefreshCredential(credential, { nowMs, refreshSkewMs }) {
  if (!credential.refreshToken) return false;
  if (!credential.expiresAt) return true;
  return credential.expiresAt - nowMs <= refreshSkewMs;
}

function shouldClaimImportedCredential(credential, { claimImportedCredential }) {
  return Boolean(
    claimImportedCredential &&
    credential.refreshToken &&
    credential.source === "claude-code-keychain" &&
    !credential.updatedAt
  );
}

function isRefreshTokenRejected(error) {
  const message = error && error.message ? error.message : String(error);
  return message.includes("Strava MCP OAuth refresh failed with HTTP 400") ||
    message.includes("Strava MCP OAuth refresh failed with HTTP 401") ||
    message.includes("invalid_grant");
}

function findTokenEndpoint(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);

  if (typeof value.token_endpoint === "string") return value.token_endpoint;
  if (typeof value.tokenEndpoint === "string") return value.tokenEndpoint;

  for (const child of Object.values(value)) {
    const found = findTokenEndpoint(child, seen);
    if (found) return found;
  }
  return null;
}

function createMacOsKeychainStore({ service, account }) {
  if (process.env.STRAVA_MCP_KEYCHAIN_BACKEND === "security-cli") {
    return createSecurityCliKeychainStore({ service, account });
  }
  return createNativeKeychainStore({ service, account });
}

function createNativeKeychainStore({ service, account }) {
  return {
    read() {
      const response = runNativeKeychainHelper({ op: "read", service, account });
      if (!response.found) return null;
      if (typeof response.value !== "string") {
        throw new Error("Native Keychain helper returned no value");
      }
      return response.value;
    },

    write(value) {
      runNativeKeychainHelper({ op: "write", service, account, value });
    },

    delete() {
      const response = runNativeKeychainHelper({ op: "delete", service, account });
      return { removed: Boolean(response.found) };
    },
  };
}

function runNativeKeychainHelper(command) {
  const helperPath = process.env.STRAVA_MCP_KEYCHAIN_HELPER ||
    path.join(__dirname, "..", "bin", "strava-keychain-helper");
  if (!fs.existsSync(helperPath)) {
    throw new Error(`Native Keychain helper not found at ${helperPath}.`);
  }

  const result = spawnSync(helperPath, [], {
    input: JSON.stringify(command),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: keychainHelperTimeoutMs(),
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error("Native Keychain helper timed out; macOS may be waiting for Keychain access approval");
    }
    throw result.error;
  }

  if (result.status !== 0) {
    let message = result.stderr.trim() || `Native Keychain helper exited with ${result.status}`;
    try {
      const parsed = JSON.parse(result.stderr);
      if (parsed && parsed.error) {
        message = parsed.status ? `${parsed.error} (${parsed.status})` : parsed.error;
      }
    } catch {
      // Keep the plain stderr message.
    }
    throw new Error(message);
  }

  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed.ok) {
      throw new Error(parsed.error || "Native Keychain helper failed");
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Native Keychain helper returned invalid JSON");
    }
    throw error;
  }
}

function keychainHelperTimeoutMs() {
  const configured = Number(process.env.STRAVA_MCP_KEYCHAIN_TIMEOUT_MS || "");
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_KEYCHAIN_HELPER_TIMEOUT_MS;
}

function createTimeoutSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function createSecurityCliKeychainStore({ service, account }) {
  return {
    read() {
      const args = ["find-generic-password", "-w"];
      if (account) args.push("-a", account);
      args.push("-s", service);
      try {
        return execFileSync("security", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        if (error.status === 44) return null;
        throw error;
      }
    },

    write(value) {
      void value;
      throw new Error("security-cli Keychain backend is read-only; use the native helper for writes");
    },

    delete() {
      throw new Error("security-cli Keychain backend is read-only; use the native helper to remove credentials");
    },
  };
}

function assertSupportedPlatform() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("strava-mcp-bridge only supports Apple Silicon Macs (darwin arm64)");
  }
}

module.exports = {
  BridgeCredentialManager,
  CLAUDE_CODE_KEYCHAIN_SERVICE,
  DEFAULT_BRIDGE_KEYCHAIN_SERVICE,
  DEFAULT_KEYCHAIN_HELPER_TIMEOUT_MS,
  DEFAULT_OAUTH_TIMEOUT_MS,
  DEFAULT_REFRESH_SKEW_MS,
  DEFAULT_TOKEN_ENDPOINT,
  createBridgeCredentialManager,
  createTokenProvider,
  credentialMetadata,
  parseBridgeCredential,
  parseClaudeCodeCredentialForStravaCredential,
  parseClaudeCodeCredentialForStravaToken,
  shouldClaimImportedCredential,
  shouldRefreshCredential,
  readClaudeCodeKeychainStravaToken,
  readClaudeCodeKeychainStravaCredential,
};

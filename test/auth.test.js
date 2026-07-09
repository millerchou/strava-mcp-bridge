"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BridgeCredentialManager,
  credentialMetadata,
  parseBridgeCredential,
  parseClaudeCodeCredentialForStravaCredential,
  parseClaudeCodeCredentialForStravaToken,
  shouldRefreshCredential,
} = require("../src/auth");

const ENDPOINT = "https://mcp.strava.com/mcp";
const TOKEN_ENDPOINT = "https://www.strava.com/oauth/mcp/token";

test("extracts Strava MCP token from Claude Code credential JSON", () => {
  const raw = JSON.stringify({
    claudeAiOauth: {
      accessToken: "not-used",
    },
    mcpOAuth: {
      "strava|abc123": {
        serverName: "strava",
        serverUrl: "https://mcp.strava.com/mcp",
        accessToken: "token-123",
      },
      "other|abc123": {
        serverName: "other",
        serverUrl: "https://example.invalid/mcp",
        accessToken: "wrong",
      },
    },
  });

  const token = parseClaudeCodeCredentialForStravaToken(raw, {
    endpoint: ENDPOINT,
  });

  assert.equal(token, "token-123");
});

test("extracts full Strava MCP credential from Claude Code credential JSON", () => {
  const raw = JSON.stringify({
    mcpOAuth: {
      "strava|abc123": {
        serverName: "strava",
        serverUrl: ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-123",
        redirectUri: "http://localhost:3118/callback",
        scope: "read activity:read",
        accessToken: "token-123",
        refreshToken: "refresh-123",
        expiresAt: 1783500448092,
      },
    },
  });

  const credential = parseClaudeCodeCredentialForStravaCredential(raw, {
    endpoint: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
  });

  assert.equal(credential.accessToken, "token-123");
  assert.equal(credential.refreshToken, "refresh-123");
  assert.equal(credential.clientId, "client-123");
  assert.equal(credential.expiresAt, 1783500448092);
});

test("rejects missing Strava MCP token", () => {
  assert.throws(
    () => parseClaudeCodeCredentialForStravaToken(JSON.stringify({ mcpOAuth: {} }), {
      endpoint: ENDPOINT,
    }),
    /No Claude Code Strava MCP OAuth token/,
  );
});

test("bridge credential manager does not import from Claude Code during normal access", async () => {
  const bridgeStore = memoryStore(null);
  const claudeStore = {
    read() {
      throw new Error("Claude Code credential should not be read");
    },
    write() {},
  };

  const manager = new BridgeCredentialManager({
    endpoint: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    claimImportedCredential: false,
    bridgeKeychainStore: bridgeStore,
    claudeCodeKeychainStore: claudeStore,
    fetchImpl: failFetch,
    now: () => 1000000000000,
  });

  await assert.rejects(
    () => manager.getAccessToken(),
    /Run `strava-mcp-bridge auth import`/,
  );
  assert.equal(bridgeStore.writes.length, 0);
});

test("bridge credential manager explicitly imports from Claude Code and stores bridge credential", async () => {
  const bridgeStore = memoryStore(null);
  const claudeStore = memoryStore(JSON.stringify({
    mcpOAuth: {
      "strava|abc123": {
        serverName: "strava",
        serverUrl: ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-123",
        accessToken: "imported-token",
        refreshToken: "imported-refresh",
        expiresAt: 2000000000000,
      },
    },
  }));

  const manager = new BridgeCredentialManager({
    endpoint: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    claimImportedCredential: false,
    bridgeKeychainStore: bridgeStore,
    claudeCodeKeychainStore: claudeStore,
    fetchImpl: failFetch,
    now: () => 1000000000000,
  });

  const credential = await manager.importFromClaudeCode({ claimImportedCredential: false });
  assert.equal(credential.accessToken, "imported-token");
  assert.equal(bridgeStore.writes.length, 1);
  assert.equal(JSON.parse(bridgeStore.writes[0]).refreshToken, "imported-refresh");
});

test("bridge credential manager claims imported Claude Code credential by refreshing it", async () => {
  const now = 1000000000000;
  const bridgeStore = memoryStore(null);
  const claudeStore = memoryStore(JSON.stringify({
    mcpOAuth: {
      "strava|abc123": {
        serverName: "strava",
        serverUrl: ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-123",
        accessToken: "imported-token",
        refreshToken: "imported-refresh",
        expiresAt: now + 3600_000,
      },
    },
  }));

  const manager = new BridgeCredentialManager({
    endpoint: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    bridgeKeychainStore: bridgeStore,
    claudeCodeKeychainStore: claudeStore,
    fetchImpl: async () => jsonResponse(200, {
      access_token: "claimed-token",
      refresh_token: "claimed-refresh",
      expires_in: 7200,
    }),
    now: () => now,
  });

  const credential = await manager.importFromClaudeCode();
  assert.equal(credential.accessToken, "claimed-token");
  assert.equal(bridgeStore.writes.length, 1);
  assert.equal(JSON.parse(bridgeStore.writes.at(-1)).source, "strava-mcp-bridge");
  assert.equal(JSON.parse(bridgeStore.writes.at(-1)).refreshToken, "claimed-refresh");
});

test("bridge credential import does not store stale Claude Code copy when claim refresh fails", async () => {
  const bridgeStore = memoryStore(null);
  const claudeStore = memoryStore(JSON.stringify({
    mcpOAuth: {
      "strava|abc123": {
        serverName: "strava",
        serverUrl: ENDPOINT,
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: "client-123",
        accessToken: "stale-token",
        refreshToken: "stale-refresh",
        expiresAt: 1000000000000,
      },
    },
  }));

  const manager = new BridgeCredentialManager({
    endpoint: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    bridgeKeychainStore: bridgeStore,
    claudeCodeKeychainStore: claudeStore,
    fetchImpl: async () => jsonResponse(401, {
      error: "invalid_grant",
    }),
    now: () => 1000000000000,
  });

  await assert.rejects(
    () => manager.importFromClaudeCode(),
    /Strava MCP OAuth refresh failed with HTTP 401/,
  );
  assert.equal(bridgeStore.writes.length, 0);
});

test("bridge credential manager does not read Claude Code when bridge credential exists", async () => {
  const bridgeStore = memoryStore(JSON.stringify({
    serverName: "strava",
    serverUrl: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: "client-123",
    accessToken: "bridge-token",
    refreshToken: "bridge-refresh",
    expiresAt: 2000000000000,
    source: "strava-mcp-bridge",
    updatedAt: "2026-07-08T00:00:00.000Z",
  }));

  const manager = new BridgeCredentialManager({
    endpoint: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    bridgeKeychainStore: bridgeStore,
    claudeCodeKeychainStore: {
      read() {
        throw new Error("Claude Code credential should not be read");
      },
      write() {},
    },
    fetchImpl: failFetch,
    now: () => 1000000000000,
  });

  assert.equal(await manager.getAccessToken(), "bridge-token");
  assert.equal(bridgeStore.writes.length, 0);
});

test("bridge credential manager refreshes expiring credential and writes rotated token", async () => {
  const now = 1000000000000;
  const bridgeStore = memoryStore(JSON.stringify({
    serverName: "strava",
    serverUrl: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: "client-123",
    accessToken: "old-token",
    refreshToken: "old-refresh",
    expiresAt: now + 30_000,
  }));
  const fetchCalls = [];

  const manager = new BridgeCredentialManager({
    endpoint: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    refreshSkewMs: 60_000,
    bridgeKeychainStore: bridgeStore,
    claudeCodeKeychainStore: memoryStore(null),
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return jsonResponse(200, {
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_at: Math.trunc((now + 3600_000) / 1000),
        token_type: "Bearer",
        scope: "read activity:read",
      });
    },
    now: () => now,
  });

  assert.equal(await manager.getAccessToken(), "new-token");
  assert.equal(fetchCalls[0].url, TOKEN_ENDPOINT);
  assert.match(fetchCalls[0].options.body, /grant_type=refresh_token/);
  assert.match(fetchCalls[0].options.body, /client_id=client-123/);
  assert.ok(fetchCalls[0].options.signal);

  const stored = JSON.parse(bridgeStore.writes.at(-1));
  assert.equal(stored.accessToken, "new-token");
  assert.equal(stored.refreshToken, "new-refresh");
  assert.equal(stored.expiresAt, now + 3600_000);
});

test("forceRefresh refreshes even when credential is not near expiry", async () => {
  const now = 1000000000000;
  const bridgeStore = memoryStore(JSON.stringify({
    serverName: "strava",
    serverUrl: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: "client-123",
    accessToken: "old-token",
    refreshToken: "old-refresh",
    expiresAt: now + 3600_000,
  }));

  const manager = new BridgeCredentialManager({
    endpoint: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    bridgeKeychainStore: bridgeStore,
    claudeCodeKeychainStore: memoryStore(null),
    fetchImpl: async () => jsonResponse(200, {
      access_token: "forced-token",
      refresh_token: "forced-refresh",
      expires_in: 7200,
    }),
    now: () => now,
  });

  assert.equal(await manager.getAccessToken({ forceRefresh: true }), "forced-token");
  assert.equal(JSON.parse(bridgeStore.writes.at(-1)).refreshToken, "forced-refresh");
});

test("refresh token rejection re-reads bridge Keychain and recovers from rotated token", async () => {
  const now = 1000000000000;
  const bridgeStore = memoryStore(JSON.stringify({
    serverName: "strava",
    serverUrl: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: "client-123",
    accessToken: "old-token",
    refreshToken: "old-refresh",
    expiresAt: now + 30_000,
  }));
  const fetchCalls = [];

  const manager = new BridgeCredentialManager({
    endpoint: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    refreshSkewMs: 60_000,
    bridgeKeychainStore: bridgeStore,
    claudeCodeKeychainStore: memoryStore(null),
    fetchImpl: async (_url, options) => {
      fetchCalls.push(options.body);
      if (fetchCalls.length === 1) {
        bridgeStore.value = JSON.stringify({
          serverName: "strava",
          serverUrl: ENDPOINT,
          tokenEndpoint: TOKEN_ENDPOINT,
          clientId: "client-123",
          accessToken: "peer-token",
          refreshToken: "peer-refresh",
          expiresAt: now + 3600_000,
          source: "strava-mcp-bridge",
        });
        return jsonResponse(401, {
          error: "invalid_grant",
        });
      }
      return jsonResponse(200, {
        access_token: "should-not-need-second-refresh",
        refresh_token: "unexpected",
        expires_in: 7200,
      });
    },
    now: () => now,
  });

  assert.equal(await manager.getAccessToken(), "peer-token");
  assert.equal(fetchCalls.length, 1);
  assert.equal(bridgeStore.writes.length, 1);
  assert.equal(JSON.parse(bridgeStore.writes.at(-1)).refreshToken, "peer-refresh");
});

test("shouldRefreshCredential respects expiry skew", () => {
  assert.equal(shouldRefreshCredential({
    refreshToken: "refresh",
    expiresAt: 10_000,
  }, {
    nowMs: 0,
    refreshSkewMs: 5_000,
  }), false);

  assert.equal(shouldRefreshCredential({
    refreshToken: "refresh",
    expiresAt: 4_000,
  }, {
    nowMs: 0,
    refreshSkewMs: 5_000,
  }), true);
});

test("rejects unexpected token endpoint unless explicitly allowed", () => {
  const raw = JSON.stringify({
    mcpOAuth: {
      "strava|abc123": {
        serverName: "strava",
        serverUrl: ENDPOINT,
        tokenEndpoint: "https://example.invalid/oauth/token",
        accessToken: "token-123",
      },
    },
  });

  assert.throws(
    () => parseClaudeCodeCredentialForStravaCredential(raw, {
      endpoint: ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
    }),
    /Unsupported Strava MCP OAuth token endpoint/,
  );

  const credential = parseClaudeCodeCredentialForStravaCredential(raw, {
    endpoint: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    allowTokenEndpointOverride: true,
  });
  assert.equal(credential.tokenEndpoint, "https://example.invalid/oauth/token");
});

test("malformed credential JSON errors do not echo raw secret bytes", () => {
  assert.throws(
    () => parseBridgeCredential("FAKESECRET-should-not-appear", {
      endpoint: ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
    }),
    (error) => {
      assert.match(error.message, /Bridge Strava MCP credential is not valid JSON/);
      assert.equal(error.message.includes("FAKESECRET"), false);
      return true;
    },
  );

  assert.throws(
    () => parseClaudeCodeCredentialForStravaToken("FAKESECRET-should-not-appear", {
      endpoint: ENDPOINT,
    }),
    (error) => {
      assert.match(error.message, /Claude Code credential is not valid JSON/);
      assert.equal(error.message.includes("FAKESECRET"), false);
      return true;
    },
  );
});

test("credential metadata does not expose token values", () => {
  const metadata = credentialMetadata({
    schemaVersion: 1,
    serverName: "strava",
    serverUrl: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: "client-123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: 1000000005000,
    scope: "read activity:read",
    tokenType: "Bearer",
    source: "strava-mcp-bridge",
  }, {
    nowMs: 1000000000000,
  });

  assert.equal(metadata.hasAccessToken, true);
  assert.equal(metadata.hasRefreshToken, true);
  assert.equal(metadata.expiresInSeconds, 5);
  assert.equal(JSON.stringify(metadata).includes("access-secret"), false);
  assert.equal(JSON.stringify(metadata).includes("refresh-secret"), false);
});

test("removeBridgeCredential deletes the bridge credential, clears cache, and is idempotent", () => {
  const bridgeStore = memoryStore(JSON.stringify({
    serverName: "strava",
    serverUrl: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: "client-123",
    accessToken: "bridge-token",
    refreshToken: "bridge-refresh",
    expiresAt: 2000000000000,
    source: "strava-mcp-bridge",
    updatedAt: "2026-07-08T00:00:00.000Z",
  }));

  const manager = new BridgeCredentialManager({
    endpoint: ENDPOINT,
    tokenEndpoint: TOKEN_ENDPOINT,
    bridgeKeychainStore: bridgeStore,
    claudeCodeKeychainStore: memoryStore(null),
    fetchImpl: failFetch,
    now: () => 1000000000000,
  });
  manager.cachedCredential = { accessToken: "cached" };

  const first = manager.removeBridgeCredential();
  assert.equal(first.removed, true);
  assert.equal(bridgeStore.value, null);
  assert.equal(manager.cachedCredential, null);
  assert.equal(JSON.stringify(first).includes("bridge-token"), false);

  const second = manager.removeBridgeCredential();
  assert.equal(second.removed, false);
});

function memoryStore(initialValue) {
  return {
    value: initialValue,
    writes: [],
    read() {
      return this.value;
    },
    write(value) {
      this.value = value;
      this.writes.push(value);
    },
    delete() {
      const removed = this.value !== null && this.value !== undefined;
      this.value = null;
      return { removed };
    },
  };
}

function jsonResponse(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(value);
    },
  };
}

async function failFetch() {
  throw new Error("fetch should not be called");
}

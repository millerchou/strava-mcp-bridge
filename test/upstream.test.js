"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { StravaMcpHttpClient } = require("../src/upstream");

test("sends bearer token and stores upstream MCP session id", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name.toLowerCase() === "mcp-session-id" ? "session-1" : null;
        },
      },
      async text() {
        return 'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n';
      },
    };
  };

  const client = new StravaMcpHttpClient({
    endpoint: "https://mcp.strava.com/mcp",
    protocolVersion: "2025-06-18",
    tokenProvider: () => "token-123",
    fetchImpl,
  });

  const response = await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });

  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.equal(calls[0].url, "https://mcp.strava.com/mcp");
  assert.equal(calls[0].options.headers.Authorization, "Bearer token-123");
  assert.ok(calls[0].options.signal);
  assert.equal(client.sessionId, "session-1");
});

test("refreshes token and retries once on upstream 401", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return {
        ok: false,
        status: 401,
        headers: { get() { return null; } },
        async text() { return '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"unauthorized"}}'; },
      };
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name.toLowerCase() === "mcp-session-id" ? "session-2" : null;
        },
      },
      async text() {
        return 'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
      },
    };
  };

  const forceRefreshValues = [];
  const client = new StravaMcpHttpClient({
    endpoint: "https://mcp.strava.com/mcp",
    protocolVersion: "2025-06-18",
    tokenProvider: async ({ forceRefresh = false } = {}) => {
      forceRefreshValues.push(forceRefresh);
      return forceRefresh ? "new-token" : "old-token";
    },
    fetchImpl,
  });

  const response = await client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  assert.equal(response.result.ok, true);
  assert.deepEqual(forceRefreshValues, [false, true]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, "Bearer old-token");
  assert.equal(calls[1].options.headers.Authorization, "Bearer new-token");
  assert.equal(client.sessionId, "session-2");
});

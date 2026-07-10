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

test("forwards all preceding SSE messages and returns the matching response", async () => {
  const forwarded = [];
  const client = new StravaMcpHttpClient({
    endpoint: "https://mcp.strava.com/mcp",
    protocolVersion: "2025-06-18",
    tokenProvider: async () => "token",
    fetchImpl: async () => response(200, [
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}',
      "",
      'data: {"jsonrpc":"2.0","id":8,"result":{"ok":true}}',
      "",
    ].join("\n")),
  });

  const result = await client.send(
    { jsonrpc: "2.0", id: 8, method: "tools/list" },
    { onMessage: (message) => forwarded.push(message) },
  );
  assert.equal(result.result.ok, true);
  assert.deepEqual(forwarded, [{
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progress: 1 },
  }]);
});

test("reinitializes the MCP session before retrying after a session 404", async () => {
  const calls = [];
  let toolsAttempts = 0;
  const client = new StravaMcpHttpClient({
    endpoint: "https://mcp.strava.com/mcp",
    protocolVersion: "2025-06-18",
    tokenProvider: async () => "token",
    fetchImpl: async (_url, options) => {
      const message = JSON.parse(options.body);
      calls.push({ message, headers: options.headers });
      if (message.method === "initialize" && calls.length === 1) {
        return response(200, jsonResult(1, { protocolVersion: "2025-06-18" }), "session-1");
      }
      if (message.method === "notifications/initialized") return response(202, "");
      if (message.method === "tools/list" && toolsAttempts++ === 0) return response(404, "");
      if (message.method === "initialize") {
        return response(200, jsonResult(1, { protocolVersion: "2025-06-18" }), "session-2");
      }
      return response(200, jsonResult(2, { tools: [] }));
    },
  });

  await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const result = await client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  assert.deepEqual(calls.map((call) => call.message.method), [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  assert.equal(calls[3].headers["Mcp-Session-Id"], undefined);
  assert.equal(calls[4].headers["Mcp-Session-Id"], "session-2");
  assert.equal(calls[5].headers["Mcp-Session-Id"], "session-2");
  assert.deepEqual(result.result.tools, []);
});

test("refreshes and reinitializes before retrying an authenticated session", async () => {
  const calls = [];
  const refreshFlags = [];
  let toolsAttempts = 0;
  const client = new StravaMcpHttpClient({
    endpoint: "https://mcp.strava.com/mcp",
    protocolVersion: "2025-06-18",
    tokenProvider: async ({ forceRefresh = false } = {}) => {
      refreshFlags.push(forceRefresh);
      return forceRefresh ? "new-token" : "old-token";
    },
    fetchImpl: async (_url, options) => {
      const message = JSON.parse(options.body);
      calls.push({ message, headers: options.headers });
      if (message.method === "initialize" && calls.length === 1) {
        return response(200, jsonResult(1, { protocolVersion: "2025-06-18" }), "session-1");
      }
      if (message.method === "notifications/initialized") return response(202, "");
      if (message.method === "tools/list" && toolsAttempts++ === 0) return response(401, "");
      if (message.method === "initialize") {
        return response(200, jsonResult(1, { protocolVersion: "2025-06-18" }), "session-2");
      }
      return response(200, jsonResult(2, { tools: [] }));
    },
  });

  await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

  assert.deepEqual(refreshFlags, [false, false, false, true]);
  assert.equal(calls[3].headers.Authorization, "Bearer new-token");
  assert.equal(calls[5].headers.Authorization, "Bearer new-token");
});

test("does not duplicate initialized notification while recovering that notification", async () => {
  const methods = [];
  const refreshFlags = [];
  let initializeCount = 0;
  let initializedCount = 0;
  const client = new StravaMcpHttpClient({
    endpoint: "https://mcp.strava.com/mcp",
    protocolVersion: "2025-06-18",
    tokenProvider: async ({ forceRefresh = false } = {}) => {
      refreshFlags.push(forceRefresh);
      return forceRefresh ? "new-token" : "old-token";
    },
    fetchImpl: async (_url, options) => {
      const message = JSON.parse(options.body);
      methods.push(message.method);
      if (message.method === "initialize") {
        initializeCount += 1;
        return response(
          200,
          jsonResult(1, { protocolVersion: "2025-06-18" }),
          `session-${initializeCount}`,
        );
      }
      initializedCount += 1;
      return initializedCount === 1 ? response(401, "") : response(202, "");
    },
  });

  await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  assert.deepEqual(methods, [
    "initialize",
    "notifications/initialized",
    "initialize",
    "notifications/initialized",
  ]);
  assert.deepEqual(refreshFlags, [false, false, true]);
});

test("closes an active upstream session with DELETE", async () => {
  const calls = [];
  const client = new StravaMcpHttpClient({
    endpoint: "https://mcp.strava.com/mcp",
    protocolVersion: "2025-06-18",
    tokenProvider: async () => "token",
    fetchImpl: async (_url, options) => {
      calls.push(options);
      if (options.method === "DELETE") return response(204, "");
      return response(200, jsonResult(1, { protocolVersion: "2025-06-18" }), "session-close");
    },
  });
  await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await client.close();

  assert.equal(calls[1].method, "DELETE");
  assert.equal(calls[1].headers["Mcp-Session-Id"], "session-close");
  assert.equal(client.sessionId, null);
});

test("preserves request id when upstream body is invalid", async () => {
  const client = new StravaMcpHttpClient({
    endpoint: "https://mcp.strava.com/mcp",
    protocolVersion: "2025-06-18",
    tokenProvider: async () => "token",
    fetchImpl: async () => response(200, "not-json"),
  });
  const result = await client.send({ jsonrpc: "2.0", id: 44, method: "tools/list" });
  assert.equal(result.id, 44);
  assert.equal(result.error.code, -32603);
});

test("rejects non-official endpoints unless diagnostic override is explicit", () => {
  assert.throws(() => new StravaMcpHttpClient({
    endpoint: "https://example.invalid/mcp",
    protocolVersion: "2025-06-18",
    tokenProvider: async () => "token",
    fetchImpl: async () => response(200, ""),
  }), /allow-endpoint-override/);

  assert.doesNotThrow(() => new StravaMcpHttpClient({
    endpoint: "https://example.invalid/mcp",
    protocolVersion: "2025-06-18",
    tokenProvider: async () => "token",
    allowEndpointOverride: true,
    fetchImpl: async () => response(200, ""),
  }));
});

function response(status, body, sessionId = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "mcp-session-id" ? sessionId : null;
      },
    },
    async text() {
      return body;
    },
  };
}

function jsonResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

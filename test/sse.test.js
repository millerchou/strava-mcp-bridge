"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseMcpResponseBody } = require("../src/sse");

test("parses plain JSON response", () => {
  const parsed = parseMcpResponseBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
  assert.deepEqual(parsed, {
    jsonrpc: "2.0",
    id: 1,
    result: { ok: true },
  });
});

test("parses first SSE data event", () => {
  const parsed = parseMcpResponseBody([
    "event: message",
    'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}',
    "",
  ].join("\n"));

  assert.deepEqual(parsed, {
    jsonrpc: "2.0",
    id: 2,
    result: { tools: [] },
  });
});

test("returns JSON-RPC error for unexpected non-JSON body", () => {
  const parsed = parseMcpResponseBody("not json");
  assert.equal(parsed.error.code, -32603);
  assert.match(parsed.error.message, /Unexpected non-JSON/);
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseMcpResponseBody, parseMcpResponseMessages } = require("../src/sse");

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

test("rejects unexpected non-JSON body", () => {
  assert.throws(() => parseMcpResponseBody("not json"), /Unexpected non-JSON/);
});

test("parses multiple SSE events and multiline data", () => {
  const parsed = parseMcpResponseMessages([
    ": keepalive",
    "event: message",
    'data: {"jsonrpc":"2.0",',
    'data: "method":"notifications/progress"}',
    "",
    "data: [DONE]",
    "",
    'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}',
    "",
  ].join("\n"));
  assert.deepEqual(parsed, [
    { jsonrpc: "2.0", method: "notifications/progress" },
    { jsonrpc: "2.0", id: 4, result: { ok: true } },
  ]);
});

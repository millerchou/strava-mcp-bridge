"use strict";

const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createPolicy } = require("../src/policy");
const { runStdioBridge } = require("../src/stdio");

test("stdio bridge processes requests in order and blocks disallowed calls", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputLines = [];
  output.on("data", (chunk) => {
    outputLines.push(...String(chunk).trim().split(/\n/).filter(Boolean));
  });

  const upstreamCalls = [];
  const upstream = {
    async send(message) {
      upstreamCalls.push(message.method);
      if (message.id === undefined) return null;
      return { jsonrpc: "2.0", id: message.id, result: { ok: true } };
    },
  };

  const bridgeDone = runStdioBridge({
    input,
    output,
    upstream,
    policy: createPolicy(),
  });

  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write('{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"list_activities","arguments":{}}}\n');
  input.end();

  await bridgeDone;

  assert.deepEqual(upstreamCalls, ["initialize", "notifications/initialized"]);
  const parsed = outputLines.map((line) => JSON.parse(line));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 1);
  assert.equal(parsed[1].id, 99);
  assert.match(parsed[1].error.message, /Blocked/);
});

test("stdio bridge attaches classified diagnostics to upstream failures", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputLines = [];
  output.on("data", (chunk) => {
    outputLines.push(...String(chunk).trim().split(/\n/).filter(Boolean));
  });

  const upstream = {
    async send() {
      throw new Error("Native Keychain helper not found at /nonexistent.");
    },
  };

  const bridgeDone = runStdioBridge({
    input,
    output,
    upstream,
    policy: createPolicy(),
  });

  input.write('{"jsonrpc":"2.0","id":7,"method":"initialize"}\n');
  input.end();
  await bridgeDone;

  const parsed = outputLines.map((line) => JSON.parse(line));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].error.code, -32603);
  assert.equal(parsed[0].error.data.code, "helper-missing");
  assert.match(parsed[0].error.data.nextAction, /setup/);
});

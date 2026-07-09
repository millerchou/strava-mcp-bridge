"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPolicy } = require("../src/policy");

test("allows initialization and tools/list by default", () => {
  const policy = createPolicy();

  assert.equal(policy.evaluate({ jsonrpc: "2.0", id: 1, method: "initialize" }).allowed, true);
  assert.equal(policy.evaluate({ jsonrpc: "2.0", id: 2, method: "tools/list" }).allowed, true);
  assert.equal(policy.evaluate({ jsonrpc: "2.0", method: "notifications/initialized" }).allowed, true);
});

test("blocks tools/call by default", () => {
  const policy = createPolicy();
  const decision = policy.evaluate({
    jsonrpc: "2.0",
    id: 99,
    method: "tools/call",
    params: { name: "list_activities", arguments: {} },
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.response.error.message, /tool is not allowed/);
});

test("allows named tools when explicitly configured", () => {
  const policy = createPolicy({ allowTools: ["health"] });
  const decision = policy.evaluate({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "health", arguments: {} },
  });

  assert.equal(decision.allowed, true);
});

test("blocks get_activity_streams without explicit streams array", () => {
  const policy = createPolicy({ allowTools: ["get_activity_streams"] });
  const decision = policy.evaluate({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_activity_streams", arguments: {} },
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.response.error.message, /explicit non-empty streams array/);
});

test("blocks get_activity_streams location and unknown streams", () => {
  const policy = createPolicy({ allowTools: ["get_activity_streams"] });
  const decision = policy.evaluate({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "get_activity_streams",
      arguments: { streams: ["time", "location", "watts_x"] },
    },
  });

  assert.equal(decision.allowed, false);
  assert.match(decision.response.error.message, /location/);
  assert.match(decision.response.error.message, /watts_x/);
});

test("allows get_activity_streams safe stream whitelist", () => {
  const policy = createPolicy({ allowTools: ["get_activity_streams"] });
  const decision = policy.evaluate({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "get_activity_streams",
      arguments: { streams: ["time", "heart_rate", "velocity_smooth", "cadence", "altitude", "distance", "temp"] },
    },
  });

  assert.equal(decision.allowed, true);
});

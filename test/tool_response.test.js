"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPolicy } = require("../src/policy");
const { transformToolResponse } = require("../src/tool_response");

function streamRequest(extra = {}) {
  return {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "get_activity_streams",
      arguments: {
        activity_id: "123456",
        streams: ["time", "heart_rate", "distance"],
        ...extra,
      },
    },
  };
}

function streamResponse(payload) {
  return {
    jsonrpc: "2.0",
    id: 7,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload),
        },
      ],
    },
  };
}

test("get_activity_streams requires stream output directory", () => {
  const transformed = transformToolResponse({
    request: streamRequest(),
    response: streamResponse({ time: [0], heart_rate: [120], distance: [0] }),
    streamOutputDir: "",
  });

  assert.equal(transformed.error.code, -32000);
  assert.match(transformed.error.message, /--data-dir or --stream-output-dir/);
});

test("tools/list only exposes allowlisted tools", () => {
  const transformed = transformToolResponse({
    request: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    response: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "health", description: "safe" },
          { name: "get_athlete_profile", description: "not allowed" },
          { name: "get_activity_streams", description: "allowed with policy guard" },
        ],
      },
    },
    policy: createPolicy({ allowTools: ["health", "get_activity_streams"] }),
  });

  assert.deepEqual(transformed.result.tools.map((tool) => tool.name), [
    "health",
    "get_activity_streams",
  ]);
});

test("get_activity_streams writes streams to file and returns only summary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strava-mcp-bridge-test-"));
  const transformed = transformToolResponse({
    request: streamRequest(),
    response: streamResponse({
      time: [0, 1],
      heart_rate: [120, 121],
      distance: [0, 3.5],
    }),
    streamOutputDir: dir,
  });

  const text = transformed.result.content[0].text;
  const summary = JSON.parse(text);
  const outputFile = path.join(dir, "123456.json");
  const saved = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  const mode = fs.statSync(outputFile).mode & 0o777;

  assert.deepEqual(saved, {
    time: [0, 1],
    heart_rate: [120, 121],
    distance: [0, 3.5],
  });
  assert.equal(summary.activity_id, "123456");
  assert.equal(summary.streams_file, path.join(dir, "123456.json"));
  assert.equal(summary.omitted_from_context, true);
  assert.deepEqual(summary.point_counts, {
    distance: 2,
    heart_rate: 2,
    time: 2,
  });
  assert.equal(mode, 0o600);
  assert.equal(text.includes("[120,121]"), false);
});

test("get_activity_streams trims requested stream names before file sink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strava-mcp-bridge-test-"));
  const transformed = transformToolResponse({
    request: streamRequest({
      streams: [" time ", " HEART_RATE "],
    }),
    response: streamResponse({
      time: [0],
      heart_rate: [120],
    }),
    streamOutputDir: dir,
  });

  const saved = JSON.parse(fs.readFileSync(path.join(dir, "123456.json"), "utf8"));
  assert.deepEqual(saved, {
    time: [0],
    heart_rate: [120],
  });
  assert.equal(transformed.error, undefined);
});

test("get_activity_streams rejects upstream location payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strava-mcp-bridge-test-"));
  const transformed = transformToolResponse({
    request: streamRequest(),
    response: streamResponse({
      time: [0],
      heart_rate: [120],
      distance: [0],
      location: [[1, 2]],
    }),
    streamOutputDir: dir,
  });

  assert.equal(transformed.error.code, -32000);
  assert.match(transformed.error.message, /location/);
  assert.equal(fs.existsSync(path.join(dir, "123456.json")), false);
});

test("non-stream tool responses redact location-like fields before context", () => {
  const transformed = transformToolResponse({
    request: {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "list_activities",
        arguments: {},
      },
    },
    response: streamResponse({
      activities: [
        {
          id: 42,
          name: "Morning Ride",
          start_latlng: [11.1, 22.2],
          end_latlng: [33.3, 44.4],
          map: {
            id: "a123",
            summary_polyline: "encoded-secret",
          },
          distance: 1000,
        },
      ],
    }),
  });

  const parsed = JSON.parse(transformed.result.content[0].text);
  assert.equal(parsed.activities[0].id, 42);
  assert.equal(parsed.activities[0].distance, 1000);
  assert.equal(parsed.activities[0].start_latlng, "[redacted_by_strava_mcp_bridge]");
  assert.equal(parsed.activities[0].end_latlng, "[redacted_by_strava_mcp_bridge]");
  assert.equal(parsed.activities[0].map, "[redacted_by_strava_mcp_bridge]");
  assert.equal(JSON.stringify(parsed).includes("encoded-secret"), false);
  assert.equal(JSON.stringify(parsed).includes("11.1"), false);
});

test("non-stream structured tool responses redact location-like fields", () => {
  const transformed = transformToolResponse({
    request: {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "list_activities",
        arguments: {},
      },
    },
    response: {
      jsonrpc: "2.0",
      id: 9,
      result: {
        structuredContent: {
          start_latlng: [11.1, 22.2],
          summary_polyline: "encoded-secret",
          distance: 1000,
        },
      },
    },
  });

  assert.equal(transformed.result.structuredContent.distance, 1000);
  assert.equal(transformed.result.structuredContent.start_latlng, "[redacted_by_strava_mcp_bridge]");
  assert.equal(transformed.result.structuredContent.summary_polyline, "[redacted_by_strava_mcp_bridge]");
  assert.equal(JSON.stringify(transformed).includes("encoded-secret"), false);
});

test("non-stream tool responses redact segment coordinates without broad false positives", () => {
  const transformed = transformToolResponse({
    request: {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "list_activities",
        arguments: {},
      },
    },
    response: streamResponse({
      segment_effort: {
        start_latitude: 11.1,
        start_longitude: 22.2,
        end_latitude: 33.3,
        end_longitude: 44.4,
        flat: true,
        format: "json",
        heatmap: "visible",
        template: "segment",
        latency_ms: 25,
        distance: 1000,
      },
    }),
  });

  const effort = JSON.parse(transformed.result.content[0].text).segment_effort;
  assert.equal(effort.start_latitude, "[redacted_by_strava_mcp_bridge]");
  assert.equal(effort.start_longitude, "[redacted_by_strava_mcp_bridge]");
  assert.equal(effort.end_latitude, "[redacted_by_strava_mcp_bridge]");
  assert.equal(effort.end_longitude, "[redacted_by_strava_mcp_bridge]");
  assert.equal(effort.flat, true);
  assert.equal(effort.format, "json");
  assert.equal(effort.heatmap, "visible");
  assert.equal(effort.template, "segment");
  assert.equal(effort.latency_ms, 25);
  assert.equal(effort.distance, 1000);
});

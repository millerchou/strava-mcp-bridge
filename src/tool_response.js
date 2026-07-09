"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { jsonRpcError } = require("./errors");
const { BLOCKED_STREAMS, SAFE_ACTIVITY_STREAMS } = require("./policy");

function transformToolResponse({ request, response, streamOutputDir, policy }) {
  if (isToolsList(request)) {
    return filterToolsListResponse({ response, policy });
  }

  if (!isToolCall(request, "get_activity_streams")) {
    return redactToolResponseLocation(response);
  }

  if (!streamOutputDir) {
    return jsonRpcError(
      request.id,
      -32000,
      "get_activity_streams requires a stream output directory from --data-dir or --stream-output-dir so large streams do not enter the MCP client context",
    );
  }

  if (response && response.error) {
    return response;
  }

  try {
    const streams = extractStreams(response);
    const requestedStreams = request.params.arguments.streams.map((stream) => String(stream).trim().toLowerCase());
    const cleanStreams = sanitizeStreams(streams, requestedStreams);
    const activityId = sanitizeActivityId(request.params.arguments.activity_id);
    const outputFile = path.join(streamOutputDir, `${activityId}.json`);

    fs.mkdirSync(streamOutputDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(outputFile, `${JSON.stringify(cleanStreams)}\n`, {
      encoding: "utf8",
      flag: "w",
      mode: 0o600,
    });
    fs.chmodSync(outputFile, 0o600);

    return {
      jsonrpc: "2.0",
      id: response.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              activity_id: activityId,
              streams_file: outputFile,
              stream_keys: Object.keys(cleanStreams).sort(),
              point_counts: pointCounts(cleanStreams),
              omitted_from_context: true,
            }),
          },
        ],
      },
    };
  } catch (error) {
    return jsonRpcError(request.id, -32000, `get_activity_streams file-sink failed: ${error.message}`);
  }
}

function isToolsList(request) {
  return request && request.method === "tools/list";
}

function isToolCall(request, name) {
  return request &&
    request.method === "tools/call" &&
    request.params &&
    request.params.name === name;
}

function filterToolsListResponse({ response, policy }) {
  if (!policy || typeof policy.isToolAllowed !== "function") {
    return response;
  }
  if (response && response.error) {
    return response;
  }

  const tools = response && response.result && response.result.tools;
  if (!Array.isArray(tools)) {
    return response;
  }

  return {
    ...response,
    result: {
      ...response.result,
      tools: tools.filter((tool) => tool && typeof tool.name === "string" && policy.isToolAllowed(tool.name)),
    },
  };
}

function redactToolResponseLocation(response) {
  if (!response || response.error) return response;
  const content = response.result && response.result.content;
  if (!response.result || typeof response.result !== "object") return response;

  let changed = false;
  let nextContent = content;
  if (Array.isArray(content)) {
    nextContent = content.map((block) => {
      if (!block || block.type !== "text" || typeof block.text !== "string") {
        return block;
      }

      const parsed = parseJsonText(block.text);
      if (!parsed.ok) return block;

      const redacted = redactLocationFields(parsed.value);
      if (!redacted.changed) return block;

      changed = true;
      return {
        ...block,
        text: JSON.stringify(redacted.value),
      };
    });
  }

  const resultFields = { ...response.result };
  delete resultFields.content;
  const redactedResultFields = redactLocationFields(resultFields);
  changed = changed || redactedResultFields.changed;

  if (!changed) return response;
  const nextResult = { ...redactedResultFields.value };
  if (content !== undefined) {
    nextResult.content = nextContent;
  }
  return {
    ...response,
    result: nextResult,
  };
}

function extractStreams(response) {
  const content = response && response.result && response.result.content;
  if (!Array.isArray(content)) {
    throw new Error("upstream tool response does not contain result.content");
  }

  const textBlock = content.find((block) => block && block.type === "text" && typeof block.text === "string");
  if (!textBlock) {
    throw new Error("upstream tool response does not contain text content");
  }

  const parsed = parseJsonTextOrThrow(textBlock.text, "upstream stream payload");
  if (parsed && parsed.streams && typeof parsed.streams === "object" && !Array.isArray(parsed.streams)) {
    return parsed.streams;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  throw new Error("upstream stream payload is not an object");
}

function sanitizeStreams(streams, requestedStreams) {
  const clean = {};
  for (const stream of requestedStreams) {
    if (BLOCKED_STREAMS.has(stream) || !SAFE_ACTIVITY_STREAMS.has(stream)) {
      throw new Error(`blocked or unknown requested stream: ${stream}`);
    }
    if (Object.prototype.hasOwnProperty.call(streams, stream)) {
      clean[stream] = streams[stream];
    }
  }

  for (const key of Object.keys(streams)) {
    const normalized = key.toLowerCase();
    if (BLOCKED_STREAMS.has(normalized)) {
      throw new Error(`upstream response contained blocked stream: ${key}`);
    }
  }

  return clean;
}

function parseJsonText(value) {
  try {
    return {
      ok: true,
      value: JSON.parse(value),
    };
  } catch {
    return {
      ok: false,
      value: null,
    };
  }
}

function parseJsonTextOrThrow(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function redactLocationFields(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactLocationFields(item);
      changed = changed || redacted.changed;
      return redacted.value;
    });
    return { value: next, changed };
  }

  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }

  let changed = false;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (isLocationLikeField(key)) {
      next[key] = "[redacted_by_strava_mcp_bridge]";
      changed = true;
      continue;
    }

    const redacted = redactLocationFields(child);
    next[key] = redacted.value;
    changed = changed || redacted.changed;
  }
  return { value: next, changed };
}

function isLocationLikeField(key) {
  const normalized = String(key).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  // "lat"/"lng"/"map" stay exact so words like "flat"/"heatmap" are not redacted;
  // suffix matches cover Strava's start_/end_ variants (start_latitude, end_latlng, ...).
  return normalized === "location" ||
    normalized === "lat" ||
    normalized === "lng" ||
    normalized === "map" ||
    normalized.endsWith("latlng") ||
    normalized.endsWith("latitude") ||
    normalized.endsWith("longitude") ||
    normalized.endsWith("polyline");
}

function sanitizeActivityId(activityId) {
  const value = String(activityId || "");
  if (!/^[0-9]+$/.test(value)) {
    throw new Error("activity_id must be numeric");
  }
  return value;
}

function pointCounts(streams) {
  const counts = {};
  for (const [key, value] of Object.entries(streams)) {
    counts[key] = Array.isArray(value) ? value.length : null;
  }
  return counts;
}

module.exports = {
  extractStreams,
  filterToolsListResponse,
  pointCounts,
  redactLocationFields,
  redactToolResponseLocation,
  sanitizeStreams,
  transformToolResponse,
};

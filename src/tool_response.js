"use strict";

const { jsonRpcError } = require("./errors");
const { BLOCKED_STREAMS, SAFE_ACTIVITY_STREAMS } = require("./policy");
const { writeStreamFileAtomic } = require("./stream_store");

function transformToolResponse({ request, response, streamOutputDir, policy }) {
  if (response && response.error) {
    return sanitizeUpstreamError(response, request && request.id);
  }

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

  try {
    const streams = extractStreams(response);
    const requestedStreams = request.params.arguments.streams.map((stream) => String(stream).trim().toLowerCase());
    const cleanStreams = sanitizeStreams(streams, requestedStreams);
    const activityId = sanitizeActivityId(request.params.arguments.activity_id);
    const outputFile = writeStreamFileAtomic({
      directory: streamOutputDir,
      activityId,
      streams: cleanStreams,
    });

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
  const tools = response && response.result && response.result.tools;
  if (!Array.isArray(tools)) {
    return jsonRpcError(response && response.id, -32603, "Upstream tools/list response did not contain result.tools");
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
  if (!response || response.error) return sanitizeUpstreamError(response, response && response.id);
  const content = response.result && response.result.content;
  if (!response.result || typeof response.result !== "object") {
    return jsonRpcError(response.id, -32603, "Upstream tool response did not contain an object result");
  }

  try {
    let changed = false;
    let nextContent = content;
    if (Array.isArray(content)) {
      nextContent = content.map((block) => {
        if (!block || block.type !== "text" || typeof block.text !== "string") {
          throw new Error("Upstream tool response contained a non-text content block");
        }

        const parsed = parseJsonText(block.text);
        if (!parsed.ok) {
          throw new Error("Upstream tool response contained non-JSON text");
        }

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
    if (content !== undefined) nextResult.content = nextContent;
    return { ...response, result: nextResult };
  } catch (error) {
    return jsonRpcError(response.id, -32000, `Tool response blocked by privacy policy: ${error.message}`);
  }
}

function extractStreams(response) {
  const structured = response && response.result && response.result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured.streams && typeof structured.streams === "object"
      ? structured.streams
      : structured;
  }
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
  const requested = new Set(requestedStreams);
  for (const [key, value] of Object.entries(streams)) {
    const stream = String(key).trim().toLowerCase();
    if (BLOCKED_STREAMS.has(stream) || !SAFE_ACTIVITY_STREAMS.has(stream)) {
      throw new Error(`upstream response contained blocked or unknown stream: ${key}`);
    }
    if (!requested.has(stream)) {
      throw new Error(`upstream response contained an unrequested stream: ${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(clean, stream)) {
      throw new Error(`upstream response contained duplicate stream keys: ${key}`);
    }
    assertPrimitiveStreamArray(value, key);
    clean[stream] = value;
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
    if (looksLikeCoordinateArray(value)) {
      return { value: "[redacted_by_strava_mcp_bridge]", changed: true };
    }
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactLocationFields(item);
      changed = changed || redacted.changed;
      return redacted.value;
    });
    return { value: next, changed };
  }

  if (typeof value === "string" && looksLikeLocationText(value)) {
    return { value: "[redacted_by_strava_mcp_bridge]", changed: true };
  }

  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }

  let changed = false;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (isLocationLikeField(key) || isSecretLikeField(key)) {
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
    normalized.startsWith("location") ||
    normalized === "lat" ||
    normalized === "lng" ||
    normalized === "map" ||
    normalized === "bbox" ||
    normalized === "bounds" ||
    normalized === "coordinates" ||
    normalized.endsWith("latlng") ||
    normalized.endsWith("latitude") ||
    normalized.endsWith("longitude") ||
    normalized.endsWith("coordinates") ||
    normalized.endsWith("bounds") ||
    normalized.endsWith("bbox") ||
    normalized.endsWith("polyline");
}

function isSecretLikeField(key) {
  const normalized = String(key).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "idtoken" ||
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "setcookie";
}

function looksLikeLocationText(value) {
  return /\bgeo:\s*[-+]?\d/i.test(value) ||
    /\b(?:lat(?:itude)?|lon(?:gitude)?|lng)\s*[:=]\s*[-+]?\d/i.test(value) ||
    /(^|[^\d])[-+]?(?:90(?:\.0+)?|[0-8]?\d\.\d+)\s*,\s*[-+]?(?:180(?:\.0+)?|1[0-7]\d\.\d+|\d?\d\.\d+)(?=$|[^\d])/i.test(value);
}

function looksLikeCoordinateArray(value) {
  if (isCoordinatePair(value)) return true;
  return value.length > 0 && value.every((item) => isCoordinatePair(item));
}

function isCoordinatePair(value) {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [latitude, longitude] = value;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (Number.isInteger(latitude) && Number.isInteger(longitude)) return false;
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

function assertPrimitiveStreamArray(value, key) {
  if (!Array.isArray(value)) {
    throw new Error(`stream ${key} is not an array`);
  }
  for (const item of value) {
    if (item !== null && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error(`stream ${key} contains a non-primitive value`);
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new Error(`stream ${key} contains a non-finite number`);
    }
  }
}

function sanitizeUpstreamError(response, requestId) {
  const upstreamCode = response && response.error && response.error.code;
  const code = Number.isInteger(upstreamCode) ? upstreamCode : -32000;
  return jsonRpcError(
    response && response.id !== undefined ? response.id : requestId,
    code,
    "Official Strava MCP returned an error; details were suppressed by strava-mcp-bridge",
  );
}

function sanitizeProtocolMessage(message) {
  return redactLocationFields(message).value;
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
  sanitizeProtocolMessage,
  sanitizeStreams,
  sanitizeUpstreamError,
  transformToolResponse,
};

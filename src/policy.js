"use strict";

const { jsonRpcError } = require("./errors");

const ALWAYS_ALLOWED_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "ping",
  "tools/list",
]);

const SAFE_ACTIVITY_STREAMS = new Set([
  "time",
  "heart_rate",
  "velocity_smooth",
  "cadence",
  "altitude",
  "distance",
  "temp",
  "watts",
  "grade_smooth",
  "moving",
]);

const BLOCKED_STREAMS = new Set([
  "location",
  "latlng",
  "lat",
  "lng",
  "longitude",
  "latitude",
  "polyline",
  "map",
]);

function createPolicy({ allowTools = [] } = {}) {
  const allowedTools = new Set(allowTools);

  return {
    allowedToolNames() {
      return Array.from(allowedTools);
    },

    evaluate(message) {
      if (isJsonRpcResponse(message)) {
        return { allowed: true };
      }
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        return {
          allowed: false,
          response: jsonRpcError(message?.id, -32600, "Invalid JSON-RPC request"),
        };
      }

      if (ALWAYS_ALLOWED_METHODS.has(message.method)) {
        return { allowed: true };
      }

      if (message.method !== "tools/call") {
        return {
          allowed: false,
          response: requestBlocked(message, `method is not allowed: ${message.method}`),
        };
      }

      const toolName = message.params && message.params.name;
      if (typeof toolName !== "string" || !toolName) {
        return {
          allowed: false,
          response: jsonRpcError(message.id, -32602, "tools/call requires params.name"),
        };
      }

      if (!allowedTools.has(toolName)) {
        return {
          allowed: false,
          response: requestBlocked(message, `tool is not allowed: ${toolName}`),
        };
      }

      if (toolName === "get_activity_streams") {
        return evaluateActivityStreamsCall(message);
      }

      return { allowed: true };
    },

    isToolAllowed(toolName) {
      return allowedTools.has(toolName);
    },
  };
}

function evaluateActivityStreamsCall(message) {
  const args = message.params && message.params.arguments;
  const streams = args && args.streams;
  if (!Array.isArray(streams) || streams.length === 0) {
    return {
      allowed: false,
      response: requestBlocked(message, "get_activity_streams requires an explicit non-empty streams array"),
    };
  }

  const badStreams = streams.filter((stream) => {
    if (typeof stream !== "string") return true;
    const normalized = stream.trim().toLowerCase();
    return BLOCKED_STREAMS.has(normalized) || !SAFE_ACTIVITY_STREAMS.has(normalized);
  });

  if (badStreams.length > 0) {
    return {
      allowed: false,
      response: requestBlocked(
        message,
        `get_activity_streams contains blocked or unknown streams: ${badStreams.join(",")}`,
      ),
    };
  }

  const normalizedStreams = streams.map((stream) => stream.trim().toLowerCase());
  return {
    allowed: true,
    message: {
      ...message,
      params: {
        ...message.params,
        arguments: {
          ...args,
          streams: normalizedStreams,
        },
      },
    },
  };
}

function isJsonRpcResponse(message) {
  return Boolean(
    message &&
    message.jsonrpc === "2.0" &&
    message.id !== undefined &&
    typeof message.method !== "string" &&
    (Object.prototype.hasOwnProperty.call(message, "result") ||
      Object.prototype.hasOwnProperty.call(message, "error")),
  );
}

function requestBlocked(message, reason) {
  if (message.id === undefined) {
    return null;
  }
  return jsonRpcError(message.id, -32000, `Blocked by strava-mcp-bridge policy: ${reason}`);
}

module.exports = {
  BLOCKED_STREAMS,
  SAFE_ACTIVITY_STREAMS,
  createPolicy,
};

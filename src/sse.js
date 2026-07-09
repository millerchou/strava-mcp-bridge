"use strict";

const { jsonRpcError } = require("./errors");

function parseMcpResponseBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line && line !== "[DONE]");

  if (dataLines.length === 0) {
    return jsonRpcError(null, -32603, `Unexpected non-JSON upstream response, length=${text.length}`);
  }

  return JSON.parse(dataLines[0]);
}

module.exports = {
  parseMcpResponseBody,
};

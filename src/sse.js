"use strict";

function parseMcpResponseMessages(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const messages = [];
  let dataLines = [];
  const flushEvent = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (!data || data === "[DONE]") return;
    messages.push(JSON.parse(data));
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flushEvent();
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line === "data" || line.startsWith("data:")) {
      let value = line === "data" ? "" : line.slice(5);
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
    }
  }
  flushEvent();

  if (messages.length === 0) {
    throw new Error(`Unexpected non-JSON upstream response, length=${text.length}`);
  }
  return messages;
}

function parseMcpResponseBody(text) {
  return parseMcpResponseMessages(text)[0] || null;
}

module.exports = {
  parseMcpResponseBody,
  parseMcpResponseMessages,
};

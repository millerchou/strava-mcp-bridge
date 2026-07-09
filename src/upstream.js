"use strict";

const { jsonRpcError } = require("./errors");
const { parseMcpResponseBody } = require("./sse");

class StravaMcpHttpClient {
  constructor({
    endpoint,
    protocolVersion,
    tokenProvider,
    requestTimeoutMs = 30_000,
    fetchImpl = globalThis.fetch,
  }) {
    if (!endpoint) throw new Error("endpoint is required");
    if (!protocolVersion) throw new Error("protocolVersion is required");
    if (typeof tokenProvider !== "function") throw new Error("tokenProvider function is required");
    if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

    this.endpoint = endpoint;
    this.protocolVersion = protocolVersion;
    this.tokenProvider = tokenProvider;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
  }

  async send(message) {
    const token = await this.tokenProvider();
    let response = await this.post(message, token);

    if (response.response.status === 401) {
      const refreshedToken = await this.tokenProvider({ forceRefresh: true });
      if (refreshedToken && refreshedToken !== token) {
        this.sessionId = null;
        response = await this.post(message, refreshedToken);
      }
    }

    if (!response.response.ok && !response.bodyText.trim()) {
      return jsonRpcError(message.id, -32000, `Upstream HTTP ${response.response.status}`);
    }

    const parsed = parseMcpResponseBody(response.bodyText);
    if (parsed && parsed.id === null && message.id !== undefined && parsed.error) {
      parsed.id = message.id;
    }
    return parsed;
  }

  async post(message, token) {
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocolVersion,
    };

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const options = {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    };
    const signal = createTimeoutSignal(this.requestTimeoutMs);
    if (signal) options.signal = signal;

    const response = await this.fetchImpl(this.endpoint, options);

    const upstreamSessionId =
      response.headers.get("mcp-session-id") ||
      response.headers.get("Mcp-Session-Id");
    if (upstreamSessionId) {
      this.sessionId = upstreamSessionId;
    }

    const bodyText = await response.text();
    return { response, bodyText };
  }
}

function createTimeoutSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

module.exports = {
  StravaMcpHttpClient,
};

"use strict";

const { DEFAULT_ENDPOINT, assertOfficialEndpoint } = require("./constants");
const { jsonRpcError } = require("./errors");
const { parseMcpResponseMessages } = require("./sse");

class StravaMcpHttpClient {
  constructor({
    endpoint = DEFAULT_ENDPOINT,
    protocolVersion,
    tokenProvider,
    requestTimeoutMs = 30_000,
    allowEndpointOverride = false,
    fetchImpl = globalThis.fetch,
  }) {
    assertOfficialEndpoint(endpoint, { allowOverride: allowEndpointOverride });
    if (!protocolVersion) throw new Error("protocolVersion is required");
    if (typeof tokenProvider !== "function") throw new Error("tokenProvider function is required");
    if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

    this.endpoint = endpoint;
    this.protocolVersion = protocolVersion;
    this.tokenProvider = tokenProvider;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
    this.initializeRequest = null;
    this.initializedNotification = null;
  }

  async send(message, { onMessage = () => {} } = {}) {
    this.rememberLifecycleMessage(message);

    let token = await this.tokenProvider();
    const hadSession = Boolean(this.sessionId);
    let exchange = await this.post(message, token);

    if (exchange.response.status === 401) {
      token = await this.tokenProvider({ forceRefresh: true });
      this.sessionId = null;
      if (message.method !== "initialize" && this.initializeRequest) {
        await this.reinitialize(token, {
          onMessage,
          sendInitialized: message.method !== "notifications/initialized",
        });
      }
      exchange = await this.post(message, token);
    } else if (exchange.response.status === 404 && hadSession) {
      this.sessionId = null;
      if (message.method !== "initialize" && this.initializeRequest) {
        await this.reinitialize(token, {
          onMessage,
          sendInitialized: message.method !== "notifications/initialized",
        });
      }
      exchange = await this.post(message, token);
    }

    return this.consumeExchange(message, exchange, { onMessage });
  }

  rememberLifecycleMessage(message) {
    if (message && message.method === "initialize") {
      this.initializeRequest = cloneJson(message);
      this.initializedNotification = null;
    } else if (message && message.method === "notifications/initialized") {
      this.initializedNotification = cloneJson(message);
    }
  }

  async reinitialize(token, { onMessage, sendInitialized = true }) {
    const initializeExchange = await this.post(this.initializeRequest, token);
    const initializeResponse = this.consumeExchange(this.initializeRequest, initializeExchange, { onMessage });
    if (!initializeResponse || initializeResponse.error) {
      throw new Error("Upstream MCP session reinitialization failed");
    }
    if (sendInitialized && this.initializedNotification) {
      const notificationExchange = await this.post(this.initializedNotification, token);
      if (!notificationExchange.response.ok) {
        throw new Error(`Upstream MCP initialized notification failed with HTTP ${notificationExchange.response.status}`);
      }
      for (const message of parseMcpResponseMessages(notificationExchange.bodyText)) {
        onMessage(message);
      }
    }
  }

  consumeExchange(request, exchange, { onMessage }) {
    if (!exchange.response.ok) {
      return jsonRpcError(request.id, -32000, `Upstream HTTP ${exchange.response.status}`);
    }

    let messages;
    try {
      messages = parseMcpResponseMessages(exchange.bodyText);
    } catch (error) {
      return jsonRpcError(request.id, -32603, error.message);
    }

    const expectsResponse = request && typeof request.method === "string" && request.id !== undefined;
    if (!expectsResponse) {
      for (const message of messages) onMessage(message);
      return null;
    }

    let matchingResponse = null;
    for (const message of messages) {
      const isMatchingResponse = message &&
        message.method === undefined &&
        message.id === request.id &&
        (Object.prototype.hasOwnProperty.call(message, "result") ||
          Object.prototype.hasOwnProperty.call(message, "error"));
      if (isMatchingResponse && !matchingResponse) {
        matchingResponse = message;
      } else {
        onMessage(message);
      }
    }

    return matchingResponse || jsonRpcError(
      request.id,
      -32603,
      "Upstream response did not contain a matching JSON-RPC response",
    );
  }

  async post(message, token) {
    const headers = this.headers(token);
    const options = {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    };
    const signal = createTimeoutSignal(this.requestTimeoutMs);
    if (signal) options.signal = signal;

    const response = await this.fetchImpl(this.endpoint, options);
    const upstreamSessionId = response.headers.get("mcp-session-id");
    if (upstreamSessionId) this.sessionId = upstreamSessionId;
    return { response, bodyText: await response.text() };
  }

  headers(token) {
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocolVersion,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  async close() {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    const token = await this.tokenProvider();
    const headers = this.headers(token);
    headers["Mcp-Session-Id"] = sessionId;
    const options = { method: "DELETE", headers };
    const signal = createTimeoutSignal(this.requestTimeoutMs);
    if (signal) options.signal = signal;
    await this.fetchImpl(this.endpoint, options);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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

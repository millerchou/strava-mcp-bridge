"use strict";

const DEFAULT_ENDPOINT = "https://mcp.strava.com/mcp";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TOKEN_ENDPOINT = "https://www.strava.com/oauth/mcp/token";

function assertOfficialEndpoint(endpoint, { allowOverride = false } = {}) {
  if (typeof endpoint !== "string" || !endpoint) {
    throw new Error("Strava MCP endpoint is required");
  }
  if (!allowOverride && endpoint !== DEFAULT_ENDPOINT) {
    throw new Error(
      `Unsupported Strava MCP endpoint: ${endpoint}. ` +
      `Expected ${DEFAULT_ENDPOINT}. Use --allow-endpoint-override only for controlled diagnosis.`,
    );
  }
  return endpoint;
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_PROTOCOL_VERSION,
  DEFAULT_TOKEN_ENDPOINT,
  assertOfficialEndpoint,
};

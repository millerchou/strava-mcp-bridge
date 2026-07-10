# Threat Model

## Assets

- Strava MCP access token.
- Strava MCP refresh token.
- Strava activity metadata and non-location activity streams.
- Local macOS Keychain item owned by this bridge.

## Trust Boundaries

- The MCP client can request JSON-RPC methods and tool calls over stdio.
- This bridge enforces local policy before forwarding requests to Strava MCP.
- Strava's official remote MCP server is the upstream authority for Strava data.
- Claude Code is used only for first-time bootstrap in the current design.
- macOS Keychain is the local secret store for steady-state operation.
- Normal operation does not read Claude Code, but retains the OAuth `clientId`
  and rotating refresh-token chain issued during the supported bootstrap.

## Non-Goals

- This project does not bypass Strava authorization.
- This project does not provide shared credentials.
- This project does not implement a fully independent first-time OAuth bootstrap
  without Claude Code.
- This project does not protect against a fully compromised local user account.

## Controls

- `tools/call` is denied by default.
- `tools/list` is filtered to the local allowlist.
- `get_activity_streams` requires an explicit non-empty stream allowlist.
- Location/GPS/polyline-like stream names are blocked before forwarding.
- Upstream stream responses are checked again before writing to disk.
- Non-stream structured JSON tool responses are recursively redacted for common
  location keys and coordinate-like strings. Non-JSON text, non-text content
  blocks, and upstream error details fail closed.
- Stream payloads may contain only requested safe keys whose values are arrays
  of numbers, booleans, or nulls.
- Stream directories are current-user-owned, non-symlink directories with mode
  `0700`. Files are atomically written with mode `0600`; existing symlink or
  non-regular targets are rejected.
- Stream files default to the user's macOS Application Support directory unless
  `--data-dir` or `--stream-output-dir` is set.
- OAuth refresh uses the official Strava MCP token endpoint by default.
- Bearer tokens are sent only to `https://mcp.strava.com/mcp` by default.
- Non-default token endpoints are rejected unless explicitly enabled for
  controlled diagnosis. This applies to both the CLI flag
  `--allow-token-endpoint-override` and the environment variable
  `STRAVA_MCP_ALLOW_TOKEN_ENDPOINT_OVERRIDE=1`; MCP client `env` blocks must be
  reviewed with the same care as command-line args.
- A non-default MCP endpoint or native helper path also requires its paired
  explicit diagnostic opt-in.
- Bridge-owned credentials are stored in a dedicated macOS Keychain item.
- Native Keychain helper access is restricted to service names matching
  `Strava MCP Bridge <name>-credentials`.
- Credentials use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
- Stream retention cleanup is explicit, filename-restricted, symlink-safe, and
  dry-run unless `--yes` is provided.

## Main Residual Risks

- First-time bootstrap still depends on Claude Code having completed Strava MCP
  OAuth. Standards-shaped dynamic client registration requests were rejected in
  testing, so no independent public-client bootstrap is currently verified.
- Strava currently documents the connector for Claude clients. This bridge is
  unofficial and Strava may change registration, token, or MCP behavior.
- Strava refresh tokens rotate; after `auth import` claims the token chain,
  Claude Code may need to re-authenticate its own Strava MCP credential.
- A user can explicitly allow high-volume data tools. The bridge reduces context
  exposure for streams, but local files still contain sensitive training data.
- Tool schemas and upstream behavior can change. Keep allowlists conservative
  and test before enabling new tools.
- Location redaction combines field-name and string-pattern checks. It can
  over-redact innocent numeric pairs and cannot prove that an unknown future
  opaque encoding is not location data. The fail-closed content policy and
  conservative tool allowlist remain primary controls.
- Tokens are not persisted outside Keychain, but they exist transiently in the
  bridge/helper process memory and local helper pipes.
- macOS Keychain ACLs authenticate the helper binary, not its caller. After the
  user grants "Always Allow" to the helper, any local process running as the
  same user can execute the helper and read, replace, or delete the bridge
  credential. The permission dialogs are
  a visible consent signal for new binaries, not process-level isolation.

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
- Non-stream JSON tool responses are redacted for common location-like fields
  before they are returned to the MCP client context.
- Stream files are written with mode `0600`.
- Stream files default to the user's macOS Application Support directory unless
  `--data-dir` or `--stream-output-dir` is set.
- OAuth refresh uses the official Strava MCP token endpoint by default.
- Non-default token endpoints are rejected unless explicitly enabled for
  controlled diagnosis. This applies to both the CLI flag
  `--allow-token-endpoint-override` and the environment variable
  `STRAVA_MCP_ALLOW_TOKEN_ENDPOINT_OVERRIDE=1`; MCP client `env` blocks must be
  reviewed with the same care as command-line args.
- Bridge-owned credentials are stored in a dedicated macOS Keychain item.
- Native Keychain helper access is restricted to services prefixed with
  `Strava MCP Bridge`.

## Main Residual Risks

- First-time bootstrap still depends on Claude Code having completed Strava MCP
  OAuth.
- Strava refresh tokens rotate; after `auth import` claims the token chain,
  Claude Code may need to re-authenticate its own Strava MCP credential.
- A user can explicitly allow high-volume data tools. The bridge reduces context
  exposure for streams, but local files still contain sensitive training data.
- Tool schemas and upstream behavior can change. Keep allowlists conservative
  and test before enabling new tools.
- Location-field redaction is defensive and schema-based. It should not be
  treated as proof that every future upstream field is privacy-safe.
- Location redaction currently covers structured JSON tool responses. Location
  data in non-`text` content blocks, such as `resource` blocks or `geo:` URIs,
  and free-text coordinates embedded in non-JSON text are not scrubbed.
- macOS Keychain ACLs authenticate the helper binary, not its caller. After the
  user grants "Always Allow", any local process running as the same user can
  execute the helper and read the bridge credential. The permission dialogs are
  a visible consent signal for new binaries, not process-level isolation.

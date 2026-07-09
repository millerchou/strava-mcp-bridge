# Strava MCP Bridge

Use this skill when the user wants to use the official Strava MCP server from an
AI coding tool that can run local stdio MCP servers, such as Codex, OpenCode, or
Grok Build, through `strava-mcp-bridge`.

## Safety Rules

- Never print, save, summarize, or place `accessToken` or `refreshToken` values
  in chat, logs, docs, screenshots, or generated config.
- Prefer project-scoped MCP config over global config for Strava data.
- Do not request location-like Strava streams. Never include `location`,
  `latlng`, `lat`, `lng`, `longitude`, `latitude`, `polyline`, or `map`.
- For `get_activity_streams`, require an explicit non-empty stream list. Safe
  streams are `time`, `heart_rate`, `velocity_smooth`, `cadence`, `altitude`,
  `distance`, `temp`, `watts`, `grade_smooth`, and `moving`.
- If stream data is needed, configure `--stream-output-dir` so large stream
  arrays are written to local files instead of being returned to the agent
  context.
- For non-stream JSON tool responses, expect the bridge to redact common
  location-like fields before returning content. Still keep new tools disabled
  until their schemas and privacy impact are reviewed.

## First-Time Flow

1. Run a read-only check:

   ```bash
   strava-mcp-bridge doctor
   ```

2. If the bridge credential is missing, ask the user to add and authorize
   Strava MCP in Claude Code first:

   ```bash
   claude mcp add --transport http strava https://mcp.strava.com/mcp
   ```

   Then, inside Claude Code, run `/mcp`, select `strava`, and complete the
   OAuth authorization. Claude Code can use Anthropic, Ollama, or another
   compatible model backend; the important part is that Claude Code completes
   the official Strava MCP OAuth flow.

3. Bootstrap the bridge-owned credential:

   ```bash
   strava-mcp-bridge bootstrap
   ```

   This may build the native Keychain helper, import the Claude Code Strava MCP
   credential, refresh once to claim the refresh-token chain, and print a Codex
   MCP config snippet. It must not print token values.

4. For Codex, place the generated snippet in the target project's
   `.codex/config.toml`, not in `~/.codex/config.toml`, unless the user
   explicitly wants global Strava MCP visibility.

5. Restart the AI coding tool or start a new session, then verify with the
   `health` tool before using activity tools.

## Codex Config Helpers

Minimal tool visibility:

```bash
strava-mcp-bridge config codex --profile minimal
```

Training sync visibility:

```bash
strava-mcp-bridge config codex \
  --profile training-sync \
  --stream-output-dir /absolute/path/to/strava-data/mcp-streams
```

The training-sync profile allows:

- `health`
- `eligibility`
- `list_activities`
- `get_activity_streams`
- `get_activity_performance`

## Failure Handling

These `code` values appear in `bootstrap`/`doctor`/`auth` output. During normal
MCP calls, failures raised inside the bridge before or while contacting
upstream (credential, Keychain, and network errors) carry the same
classification in the JSON-RPC `error.data.code` and `error.data.nextAction`
fields. Upstream HTTP error responses and local policy blocks do not carry
`error.data`.

- `helper-missing`: run `strava-mcp-bridge setup`, then retry.
- `keychain-approval-timeout`: tell the user macOS may be waiting for a
  Keychain prompt. Retry after the user allows access.
- `keychain-access-denied`: macOS refused the Keychain access request (a denied
  dialog, a locked login Keychain, or a session that cannot show dialogs);
  nothing was read. Retry in a GUI session and ask the user to click Allow or
  Always Allow.
- `claude-code-credential-missing`: Claude Code has not stored a usable local
  credential. Ask the user to open Claude Code and authorize Strava MCP through
  `/mcp`, then rerun `strava-mcp-bridge bootstrap`.
- `claude-code-no-mcp-servers`: Claude Code has no MCP servers configured at
  all. Ask the user to run
  `claude mcp add --transport http strava https://mcp.strava.com/mcp`,
  authorize it from `/mcp`, then rerun bootstrap.
- `claude-code-strava-missing`: Claude Code credentials exist, but there is no
  Strava MCP OAuth entry for `https://mcp.strava.com/mcp`. Ask the user to run
  `claude mcp add --transport http strava https://mcp.strava.com/mcp` (if not
  added yet), authorize it from `/mcp`, then rerun bootstrap.
- `refresh-token-stale`: the copied refresh token was rejected, usually because
  the token chain has already rotated. Ask the user to re-authorize Strava MCP
  in Claude Code, then rerun bootstrap.
- `refresh-token-missing`: the stored credential cannot refresh. Ask the user to
  re-authorize Strava MCP in Claude Code, then rerun bootstrap.
- `network-error`: the OAuth refresh or upstream request could not reach the
  network. Ask the user to check connectivity to `https://www.strava.com`,
  then retry.
- `invalid-profile`: use `--profile minimal` or `--profile training-sync`.
- `setup-build-failed`: the native helper build failed. Ask the user to install
  Xcode Command Line Tools (`xcode-select --install`) and review the compiler
  output.
- `unsupported-platform`: this bridge supports only Apple Silicon macOS.
- `unknown`: inspect the command output and rerun `strava-mcp-bridge doctor
  --json` if useful. Redact any secrets before sharing logs.

## Steady State

After successful bootstrap, normal MCP calls should use `--auth
bridge-keychain`. The bridge reads and refreshes its own macOS Keychain item and
does not need Claude Code unless the bridge-owned refresh token is missing,
revoked, or rejected by Strava.

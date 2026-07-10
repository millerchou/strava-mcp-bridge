# strava-mcp-bridge

Use the official Strava MCP from local stdio AI coding tools — no Strava
developer app required.

This is an unofficial, community-built project. It is not affiliated with or
endorsed by Strava, Anthropic (Claude Code), OpenAI (Codex), or the OpenCode
maintainers.

This project is an experimental compatibility bridge for MCP clients that can
run local stdio servers, such as Codex, OpenCode, and similar coding agents.
It forwards safe MCP requests to Strava's official remote MCP endpoint:

The [official Strava MCP documentation](https://support.strava.com/en-us/articles/15401531-strava-mcp-connector)
currently requires a Strava subscription and documents Claude clients. This
bridge is an unsupported community integration; Strava can change its OAuth or
MCP behavior at any time.

```text
stdio MCP client
  -> strava-mcp-bridge
  -> https://mcp.strava.com/mcp
```

## Quick Start

```bash
# One-time prerequisite: add and authorize the official Strava MCP in Claude Code
claude mcp add --transport http strava https://mcp.strava.com/mcp
# ...then run /mcp inside Claude Code and complete the Strava authorization.

# Install from the current source release (Apple Silicon macOS)
git clone https://github.com/millerchou/strava-mcp-bridge.git
cd strava-mcp-bridge
npm install -g .

# Import the credential into the bridge's own Keychain item
strava-mcp-bridge bootstrap
```

`bootstrap` prints a config snippet; add it to the target project's
`.codex/config.toml`. See [Usage](#usage) for the full flow and
[Safety Defaults](#safety-defaults) for what is allowed before you enable any
tools.

## Current Scope

This bridge is macOS Apple Silicon only (`darwin arm64`).

The current bootstrap assumption is:

1. The user authorizes Strava MCP through Claude Code.
2. Claude Code stores the official Strava MCP OAuth token locally.
3. The user explicitly runs `strava-mcp-bridge bootstrap` or
   `strava-mcp-bridge auth import`.
4. The bridge imports the Strava MCP OAuth credential into its own macOS
   Keychain item.
5. After that migration, this bridge reads and refreshes its own Keychain
   credential without invoking or reading Claude Code during normal operation.

You can use Claude Code with Anthropic's normal model backend, or launch Claude
Code through Ollama or another Claude Code-compatible backend. The model backend
is not the important part. The important part is that Claude Code completed the
official Strava MCP OAuth flow. A paid Claude subscription is therefore not a
bridge requirement, but a qualifying Strava subscription is still required by
the official Strava MCP.

"No longer depends on Claude Code" is operational, not cryptographic: the
bridge still uses the OAuth `clientId` and rotating refresh-token chain issued
during that first Claude Code authorization. If Strava revokes or changes that
client identity, the user must authorize again through a currently supported
client.

## How This Differs From Other Strava MCP Projects

- **Developer-app-free bootstrap** — no user-created Strava developer app or
  user-supplied client ID/secret to get started.
- **Claude Code OAuth bootstrap** — the initial credential comes from an
  official Strava MCP OAuth flow completed in Claude Code, imported on an
  explicit user action.
- **Bridge-owned Keychain credential** — after import, the credential lives in
  the bridge's own macOS Keychain item and is refreshed independently.
- **Talks to the official Strava MCP** — a bridge to Strava's official endpoint,
  not a self-built MCP server wrapping the Strava REST API.

## What This Does Not Do

- It does not bypass Strava authorization.
- It does not provide shared Strava credentials.
- It does not require a Strava developer app for the current Claude Code
  bootstrap mode.
- It does not call Strava data tools by default.
- It does not print OAuth token values.
- It does not persist OAuth token values outside the bridge-owned macOS Keychain
  item. Tokens necessarily exist transiently in bridge/helper process memory and
  the helper's local stdin/stdout pipes.
- It does not modify Claude Code config or Keychain credentials.
- It does not write refreshed tokens back into Claude Code's Keychain item.
- The MCP server startup path does not import from Claude Code. Import is a
  separate, explicit `bootstrap` or `auth import` command.

## Safety Defaults

Allowed by default:

- `initialize`
- `notifications/initialized`
- `notifications/cancelled`
- `notifications/progress`
- `ping`
- `tools/list`
- JSON-RPC responses to upstream server requests

Blocked by default:

- `tools/call`
- every other JSON-RPC request method

`tools/list` is also filtered. The MCP client only sees tools that are present
in the local `--allow-tool` list, even if the upstream Strava MCP server exposes
more tools.

If `get_activity_streams` is explicitly allowed, the bridge still requires an
explicit stream whitelist and blocks location-like streams before forwarding the
request. The currently allowed stream names are:

- `time`
- `heart_rate`
- `velocity_smooth`
- `cadence`
- `altitude`
- `distance`
- `temp`
- `watts`
- `grade_smooth`
- `moving`

Location/GPS/polyline-like stream names are blocked.

For other JSON tool responses, the bridge redacts common location-like fields
before returning content to the MCP client context, including `location`,
`latlng`, `start_latlng`, `end_latlng`, `lat`, `lng`, `latitude`, `longitude`,
`coordinates`, `bounds`, `bbox`, `polyline`, `summary_polyline`, and `map`.
Non-JSON text content and non-text content blocks fail closed instead of being
passed through. This is a defensive filter around an upstream service whose
response schemas can change; keep new tools disabled until you have reviewed
their output and privacy implications.

Full `get_activity_streams` arrays can be very large, so the bridge writes them
to disk and returns only a small summary containing `streams_file`, stream names,
and point counts. This avoids putting full activity streams into the coding
agent context.

By default, local Strava data is stored under:

```text
~/Library/Application Support/strava-mcp-bridge/
```

Stream files go to:

```text
~/Library/Application Support/strava-mcp-bridge/streams/
```

Use `--data-dir` to move all bridge-managed local data, or
`--stream-output-dir` to override only the stream file sink.

The final stream directory must be a real directory owned by the current user;
it is set to mode `0700`. Files are written atomically with mode `0600`, and
symlink targets are rejected. Retention cleanup is explicit and dry-run by
default:

```bash
strava-mcp-bridge streams prune --older-than-days 30
strava-mcp-bridge streams prune --older-than-days 30 --yes
```

The equivalent environment variables are `STRAVA_MCP_DATA_DIR` and
`STRAVA_MCP_STREAM_OUTPUT_DIR`.

Security-sensitive environment variables are treated the same as command-line
flags. Review MCP client `env` blocks before trusting a config. In particular,
`STRAVA_MCP_TOKEN_ENDPOINT` together with
`STRAVA_MCP_ALLOW_TOKEN_ENDPOINT_OVERRIDE=1` can redirect OAuth refresh requests
and must be used only for controlled local diagnosis. Likewise, a non-official
`STRAVA_MCP_URL` is rejected unless
`STRAVA_MCP_ALLOW_ENDPOINT_OVERRIDE=1` is also set (the CLI equivalent is
`--allow-endpoint-override`). A custom
`STRAVA_MCP_KEYCHAIN_HELPER` is rejected unless
`STRAVA_MCP_ALLOW_KEYCHAIN_HELPER_OVERRIDE=1` is also set.

Other supported environment variables, grouped by purpose:

- Upstream and protocol: `STRAVA_MCP_URL`,
  `STRAVA_MCP_ALLOW_ENDPOINT_OVERRIDE`, `MCP_PROTOCOL_VERSION`
- Auth and credential handling: `STRAVA_MCP_AUTH`,
  `STRAVA_MCP_BRIDGE_KEYCHAIN_SERVICE`, `STRAVA_MCP_CLAIM_ON_IMPORT`,
  `STRAVA_MCP_NO_CLAIM_ON_IMPORT`, `STRAVA_MCP_REFRESH_SKEW_SECONDS`,
  `STRAVA_MCP_ACCESS_TOKEN` (only read with `--auth env`)
- Timeouts: `STRAVA_MCP_OAUTH_TIMEOUT_MS`, `STRAVA_MCP_UPSTREAM_TIMEOUT_MS`,
  `STRAVA_MCP_KEYCHAIN_TIMEOUT_MS`
- Tool allowlist and Keychain plumbing: `STRAVA_MCP_ALLOWED_TOOLS`,
  `STRAVA_MCP_KEYCHAIN_BACKEND`, `STRAVA_MCP_KEYCHAIN_HELPER`,
  `STRAVA_MCP_ALLOW_KEYCHAIN_HELPER_OVERRIDE`

## Requirements

- Node.js 22+
- Apple Silicon macOS (`darwin arm64`)
- Swift compiler / Xcode Command Line Tools, used to build the native Keychain
  helper. Install them first with `xcode-select --install`; `npm install -g`
  compiles the helper and fails with instructions when they are missing.
- A prior Claude Code Strava MCP authorization for the first import (see
  [Usage](#usage) for the one-time `claude mcp add` prerequisite)
- A Strava subscription eligible for the official Strava MCP

## Usage

Install the current source checkout and build its native Keychain helper:

```bash
git clone https://github.com/millerchou/strava-mcp-bridge.git
cd strava-mcp-bridge
npm install -g .
```

After the package's first npm release, registry installation will be:

```bash
npm install -g strava-mcp-bridge
```

To run directly from an existing source checkout without installing globally:

```bash
npm run setup
# or:
node bin/strava-mcp-bridge.js setup
```

Run a read-only local check:

```bash
strava-mcp-bridge doctor
strava-mcp-bridge doctor --json
```

The first credential comes from Claude Code, so add and authorize the official
Strava MCP there once:

```bash
claude mcp add --transport http strava https://mcp.strava.com/mcp
```

Then, inside Claude Code, run `/mcp`, select `strava`, and complete the OAuth
authorization in the browser. This is a one-time prerequisite; after the import
below, normal bridge operation does not invoke or read Claude Code. Claude Code
does not need a paid Claude backend for this step if it is launched with Ollama
or another compatible backend.

Once Claude Code has authorized Strava MCP, bootstrap the bridge-owned
credential:

```bash
strava-mcp-bridge bootstrap
```

`bootstrap` builds the native helper if it is missing, imports the Claude Code
Strava MCP OAuth credential if the bridge-owned Keychain item is missing or
incomplete, refreshes it when due, and always prints a Codex MCP config snippet.
If the bridge refresh token is rejected after the user has re-authorized in
Claude Code, an explicit `bootstrap` retries one fresh import. Token values are
never printed.

If Claude Code has no Strava MCP credential yet, or if the copied refresh token
is stale, the command exits with a specific next action. Typical fixes are:

- Add and authorize Strava MCP in Claude Code first (see the `claude mcp add`
  command above), then rerun `strava-mcp-bridge bootstrap`.
- If macOS shows a Keychain permission dialog, follow the item-specific advice
  below rather than granting `/usr/bin/security` permanent access (see
  ["Why Does macOS Ask For Keychain Permission?"](#why-does-macos-ask-for-keychain-permission)),
  then rerun the command if it timed out while waiting.
- If the native helper is missing, run `strava-mcp-bridge setup`.

You can also explicitly import the credential into the bridge-owned Keychain
item:

```bash
strava-mcp-bridge auth import
```

`auth import` refreshes once by default. This is a credential migration, not a
passive copy: it claims the refresh-token chain for
the bridge-owned credential, which is what makes later operation independent
from Claude Code. Because Strava refresh tokens rotate, Claude Code's copied
Strava MCP refresh token may become stale after this. Claude Code can
re-authenticate Strava later if it needs its own fresh credential again.

To import without immediately claiming the refresh token chain:

```bash
strava-mcp-bridge auth import --no-claim-on-import
```

Inspect bridge credential metadata without printing token values:

```bash
strava-mcp-bridge auth status
strava-mcp-bridge auth status --json
```

Generate Codex MCP config without touching any file:

```bash
strava-mcp-bridge config codex --profile minimal
strava-mcp-bridge config codex --profile training-sync \
  --stream-output-dir /absolute/path/to/strava-data/mcp-streams
```

Run with a token provided by environment variable (requires `--auth env`;
without it, the default `bridge-keychain` mode ignores the variable):

```bash
STRAVA_MCP_ACCESS_TOKEN=... node bin/strava-mcp-bridge.js --auth env
```

Run with the bridge-owned macOS Keychain credential. This is the default mode:

```bash
strava-mcp-bridge --auth bridge-keychain
```

`bridge-keychain` reads a separate bridge-owned Keychain item named:

```text
Strava MCP Bridge Native-credentials
```

If this item does not exist, the server exits and tells you to run
`strava-mcp-bridge auth import`. This avoids hidden mutation of Claude Code
credentials during MCP server startup.

Keychain reads and writes use a small Swift helper built on macOS
`Security.framework`. Secrets are passed to the helper over stdin/stdout, not as
command-line arguments. The helper accepts only service names shaped like
`Strava MCP Bridge <name>-credentials` (including the default
`Strava MCP Bridge Native-credentials`).

If multiple MCP clients run bridge processes at the same time, one process may
rotate the Strava refresh token while another still has an older in-memory copy.
When Strava rejects that older refresh token, the bridge re-reads its Keychain
credential once and retries with the latest stored credential.

The one-time Claude Code import path still uses
`/usr/bin/security find-generic-password -w` to read Claude Code's existing
Keychain item because that item is owned by Claude Code's access control list.
This read is not a steady-state dependency and does not put secrets in
command-line arguments.

On server runs it reads only that bridge-owned item. It refreshes tokens through
Strava MCP's OAuth token endpoint when the access token has one hour or less
left before expiry, and also retries once after an upstream HTTP 401 by forcing
a refresh. Refresh requests bind the grant to
`resource=https://mcp.strava.com/mcp`. If an upstream MCP session expires, the
bridge repeats the saved `initialize` handshake before retrying the request; it
also sends an MCP session `DELETE` when stdio closes.

Keychain helper calls time out after 120 seconds by default. OAuth refresh and
upstream MCP requests time out after 30 seconds by default.

For emergency diagnosis only, the old `/usr/bin/security` CLI backend can be
selected explicitly. This fallback is read-only and cannot write refreshed
credentials:

```bash
STRAVA_MCP_KEYCHAIN_BACKEND=security-cli node bin/strava-mcp-bridge.js --auth bridge-keychain
```

Run with the direct Claude Code Keychain helper for migration or diagnosis:

```bash
strava-mcp-bridge --auth claude-code-keychain
```

Allow a specific tool call:

```bash
strava-mcp-bridge --auth bridge-keychain --allow-tool health
```

Allow full-resolution stream fetches while keeping the large result out of
context:

```bash
strava-mcp-bridge \
  --auth bridge-keychain \
  --allow-tool get_activity_streams
```

For a project-specific pipeline, set an explicit stream sink:

```bash
strava-mcp-bridge \
  --auth bridge-keychain \
  --allow-tool get_activity_streams \
  --stream-output-dir /absolute/path/to/strava-data/mcp-streams
```

The default mode is intentionally list-only. Do not enable tools until you have
reviewed their schemas and privacy implications.

## Removing The Bridge / Revoking Access

To delete the bridge-owned macOS Keychain credential:

```bash
strava-mcp-bridge auth remove          # prints what would be removed, changes nothing
strava-mcp-bridge auth remove --yes    # actually removes the Keychain item
```

Without `--yes`, the command only prints the target Keychain item and exits
without touching anything. `auth remove` deletes only the bridge-owned item
(`Strava MCP Bridge Native-credentials`); it never touches Claude Code's
credential, and removing when nothing is stored is a no-op.

This deletes the local credential only. To revoke the bridge's access on
Strava's side, deauthorize the connection from your Strava account settings
under the list of connected apps. After removal you can start over by re-running
`strava-mcp-bridge bootstrap`.

## Why Does macOS Ask For Keychain Permission?

During `bootstrap`, and again after upgrades, macOS may show a dialog like
_"strava-keychain-helper" wants to use your confidential information stored in
"Strava MCP Bridge Native-credentials"_. This is macOS Keychain access control
working as intended, not the bridge doing something unexpected. Two Keychain
items are involved:

- `Claude Code-credentials` — read once by the macOS `security` tool during
  `bootstrap` / `auth import`. This is the explicit one-time import you
  requested; the bridge never touches this item outside those commands.
- `Strava MCP Bridge Native-credentials` — the bridge's own item, read and
  updated by `strava-keychain-helper` during normal operation.

What to click:

- For `security` reading `Claude Code-credentials`, choose **Allow**. Do not
  choose **Always Allow** for the general-purpose `/usr/bin/security` program.
- For `strava-keychain-helper` reading the bridge-owned item, **Allow** is the
  least-privilege choice and may prompt again. **Always Allow** avoids repeat
  prompts, but any process already running as your macOS user can invoke the
  unsigned helper to read, replace, or delete the bridge credential, so use it
  only if you accept that same-user risk.
- **Deny** — the current command fails safely; nothing is read and nothing is
  lost.

Why it comes back after an upgrade: the helper is compiled from source on your
machine at install time and is ad-hoc signed, so macOS ties "Always Allow" to
that exact binary. A reinstall or upgrade produces a new binary, which macOS
treats as a new program and asks about once more. One dialog per upgrade is
expected.

The dialog is also a feature, not just friction: the audience for this bridge
runs AI coding agents with shell access, and this dialog is the one visible
signal a human gets when any new program tries to read the stored Strava
credential. See [THREAT_MODEL.md](THREAT_MODEL.md) for the limits of this
protection.

## Codex Example

See [examples/codex-config.toml](examples/codex-config.toml).

Add the snippet to the target project's `.codex/config.toml` (project-scoped).
Avoid `~/.codex/config.toml` unless you want every project to see the bridge.
This is the same TOML that `strava-mcp-bridge config codex --profile minimal`
prints (see [Usage](#usage)), so you can generate it instead of copying it.

For first-time setup from an AI coding tool, prefer the bundled skill at
[skills/strava-mcp-bridge/SKILL.md](skills/strava-mcp-bridge/SKILL.md). It tells
the agent to run `doctor`, then `bootstrap`, then use project-scoped config.

```toml
[mcp_servers.strava_bridge]
command = "node"
args = [
  "/absolute/path/to/strava-mcp-bridge/bin/strava-mcp-bridge.js",
  "--auth",
  "bridge-keychain",
  "--allow-tool",
  "health,eligibility"
]
```

For training sync workflows, explicitly add the tools you need, for example:

```toml
  "--allow-tool",
  "health,eligibility,list_activities,get_activity_streams,get_activity_performance",
  "--stream-output-dir",
  "/absolute/path/to/strava-data/mcp-streams"
```

If you omit `--stream-output-dir`, stream files are written under the default
user-level data directory:

```text
~/Library/Application Support/strava-mcp-bridge/streams/
```

After saving the config, restart Codex or start a new session, then verify the
link with the `health` tool before enabling any activity tools.

## Development

Build the native Keychain helper:

```bash
npm run setup
```

Run tests:

```bash
npm test
npm pack --dry-run
```

The test suite uses only local mocks. It does not contact Strava and does not
read Keychain.

The npm publish workflow uses GitHub OIDC trusted publishing and contains no
long-lived npm token. Before the first automated release, the package owner must
claim `strava-mcp-bridge` on npm and configure `publish.yml` as its trusted
GitHub publisher. Release tags must exactly match `v<package.json version>`.

## Security

See [SECURITY.md](SECURITY.md) and [THREAT_MODEL.md](THREAT_MODEL.md).

## Research Status

Validated locally through 2026-07-10:

- Claude Code launched through Ollama can authenticate official Strava MCP.
- A non-Claude local client can complete `initialize` and `tools/list` with the
  user-authorized bearer token.
- A stdio bridge can forward `initialize` and `tools/list` to official Strava
  MCP while blocking `tools/call` locally.
- Strava MCP OAuth discovery identifies the token endpoint as
  `https://www.strava.com/oauth/mcp/token`.
- The bridge can import once from Claude Code, store its own credential, refresh
  with the official refresh token grant, and avoid writing anything back to
  Claude Code.
- Keychain operations use a Swift `Security.framework` helper by default,
  avoiding token-bearing command-line arguments.
- Strava advertises OAuth protected-resource and authorization-server metadata,
  including a dynamic client registration endpoint. However, isolated Codex
  `0.142.5` reported no authorization support for this server, and three
  standards-shaped RFC 7591 registration requests were all rejected with
  `400 invalid_client_metadata`. No client ID or token was issued.
- Therefore no verified standards-only first-time path currently removes the
  Claude Code bootstrap. The effective gate is OAuth client registration/token
  issuance, not the LLM model or a simple Claude-shaped User-Agent header.
- Strava's public documentation currently describes the connector for Claude
  clients and [says support for other clients is planned](https://support.strava.com/en-us/articles/15401526-strava-api-and-mcp-faq).
  This bridge remains unofficial and outside that documented support surface.

The remaining open question is whether Strava will publish a usable client
registration policy or officially support additional MCP clients:

```text
How can a non-Claude-Code client obtain its first valid official Strava MCP
OAuth credential without Claude Code and without requiring a user-created Strava
developer app?
```

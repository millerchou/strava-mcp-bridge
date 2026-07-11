# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Complete multi-event SSE parsing, MCP session reinitialization, session
  deletion on shutdown, and protocol-safe ping/cancellation/response handling.
- Atomic, symlink-safe stream storage plus dry-run retention pruning.
- Node.js 22/24 CI and npm OIDC trusted-publishing workflow.

### Changed

- Reworked the README around user outcomes, fit, privacy, and alternatives, with
  a shorter first-time path and an explicit comparison table.
- Made npm release publishing idempotent and documented the one-time package
  claim and trusted-publisher setup.
- Added a redaction-first bug report form for early adopter diagnostics.
- Made the bundled Codex skill discoverable from `.agents/skills` and added an
  explicit, overwrite-safe `skill install` CLI command for user or project
  scope.
- Added npm ownership metadata and `server.json` for publication to the official
  MCP Registry after the first npm release.
- Pin official MCP/OAuth endpoints by default and bind refresh grants to the MCP
  resource.
- Fail closed for opaque tool-response content and sanitize upstream errors.
- Restrict native Keychain service names and require unlocked-device access.
- Re-import an explicitly re-authorized Claude credential when bootstrap detects
  a rejected bridge refresh chain.
- Clarify Strava subscription, Claude subscription, OAuth identity, and
  item-specific Keychain permission behavior.

## [0.1.0] - 2026-07-08

### Added

- Initial experimental stdio bridge for Strava's official remote MCP server.
- Bridge-owned macOS Keychain credential storage.
- Explicit `auth import`, `auth status`, and `auth remove` commands.
- `bootstrap`, `doctor`, and `config codex` commands for first-time AI coding
  tool setup and non-sensitive diagnostics.
- A bundled AI coding tool skill for Strava MCP Bridge setup and safety rules.
- Default-deny tool policy and filtered `tools/list`.
- Location-field redaction for non-stream JSON tool responses.
- File sink for `get_activity_streams` to keep full streams out of MCP client
  context.
- Default macOS Application Support data directory and `--data-dir` override.
- Location/GPS/polyline stream blocking.
- Keychain retry behavior for concurrent refresh-token rotation.
- Safe malformed-credential JSON errors that do not echo raw secret text.
- Keychain permission dialog guidance: a pre-dialog notice during `bootstrap`
  and a README FAQ explaining which button to click and when dialogs reappear.
- Classified, actionable errors across `bootstrap`, `doctor`, and `auth`
  commands (network, denied Keychain dialog, missing Xcode Command Line Tools,
  invalid profile, and Claude Code prerequisite cases); stdio JSON-RPC errors
  carry the same diagnostics in `error.data`.

# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

# Security Policy

## Supported Versions

This project is experimental. Security fixes target the latest released `0.1.x`
version until a stable release policy exists.

## Reporting a Vulnerability

Do not include access tokens, refresh tokens, Keychain dumps, or activity data in
public issues.

If the repository has GitHub private vulnerability reporting enabled, use that.
Otherwise, open a minimal public issue that describes the affected component and
ask for a private contact path. Include only redacted logs and reproduction
steps.

## Sensitive Data Rules

- OAuth token values must never be printed in logs, CLI output, test fixtures
  copied from real machines, issues, or pull requests.
- `auth status` may show only metadata such as expiry time, scope, and boolean
  token presence.
- Full activity stream arrays are written to local files and are not returned to
  the MCP client context.
- Location/GPS/polyline-like stream names are blocked by local policy.
- Other structured JSON tool responses are redacted for common location-like
  fields before they are returned to the MCP client context. Non-JSON text,
  non-text content blocks, and upstream error details fail closed.
- The official MCP and OAuth token endpoints are pinned by default. Their
  diagnostic override flags must never be present in unreviewed MCP config.
- Stream directories must be current-user-owned real directories with mode
  `0700`; stream files are atomically written with mode `0600`, and symlink
  targets are rejected.
- Treat MCP client `env` entries as security-sensitive. Do not set
  `STRAVA_MCP_ALLOW_ENDPOINT_OVERRIDE=1`,
  `STRAVA_MCP_ALLOW_TOKEN_ENDPOINT_OVERRIDE=1`,
  `STRAVA_MCP_ALLOW_KEYCHAIN_HELPER_OVERRIDE=1`, or their paired override values
  unless you are doing controlled local diagnosis.

## Keychain Permission Dialogs

macOS Keychain dialogs are expected behavior. Choose only **Allow** when the
general-purpose `/usr/bin/security` process asks to read `Claude
Code-credentials`. For the dedicated `strava-keychain-helper`, **Allow** is
least privilege; **Always Allow** is an optional convenience that binds the
grant to that helper binary. Note the limit: once granted, any local process
running as the same user can execute the unsigned helper and read, replace, or
delete the bridge credential. Local same-user processes are inside the trust
boundary; see
[THREAT_MODEL.md](THREAT_MODEL.md).

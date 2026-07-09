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
- Other JSON tool responses are redacted for common location-like fields before
  they are returned to the MCP client context.
- Treat MCP client `env` entries as security-sensitive. Do not set
  `STRAVA_MCP_ALLOW_TOKEN_ENDPOINT_OVERRIDE=1` or `STRAVA_MCP_TOKEN_ENDPOINT`
  unless you are doing controlled local diagnosis.

## Keychain Permission Dialogs

macOS Keychain dialogs for `strava-keychain-helper` are expected behavior; the
README section "Why Does macOS Ask For Keychain Permission?" explains when they
appear and what to click. "Always Allow" binds the grant to the exact helper
binary, so a rebuilt or upgraded helper triggers one new dialog. Note the limit
of this control: once granted, any local process running as the same user can
execute the helper and read the bridge credential. Local same-user processes
are inside the trust boundary; see [THREAT_MODEL.md](THREAT_MODEL.md).

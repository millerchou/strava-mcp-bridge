# Releasing strava-mcp-bridge

This document records the completed one-time npm package claim and trusted
publisher setup, then defines the process for later automated releases. Do not
publish a future GitHub Release until its matching npm prerequisites are met.

## One-Time First npm Publication (Completed For `0.1.0`)

`strava-mcp-bridge@0.1.0` was published manually to claim the unscoped package.
Do not repeat this section for later releases; use the trusted GitHub workflow
described below.

1. Confirm the release commit is on `main` and CI is green.
2. Confirm `package.json` is still version `0.1.0`.
3. Authenticate locally:

   ```bash
   npm login
   npm whoami
   ```

4. Verify the exact package contents:

   ```bash
   npm test
   npm run build:keychain-helper
   npm pack --dry-run
   ```

5. Publish the first package:

   ```bash
   npm publish --access public
   ```

6. Verify the registry:

   ```bash
   npm view strava-mcp-bridge version
   npm view strava-mcp-bridge dist.tarball
   ```

Do not paste npm passwords, OTPs, recovery codes, or tokens into an issue,
commit, AI conversation, or shell history beyond npm's own interactive prompt.

## Configure npm Trusted Publishing (Completed)

The trusted publisher is configured for this repository. The completed one-time
setup was:

1. Open the package settings on npmjs.com.
2. Add a GitHub Actions trusted publisher.
3. Configure:

   ```text
   GitHub user or organization: millerchou
   Repository: strava-mcp-bridge
   Workflow filename: publish.yml
   Environment: leave empty
   Allowed action: npm publish
   ```

4. Save the trusted publisher.
5. Prefer OIDC publishing and remove any long-lived automation token that is no
   longer needed.

The workflow has `id-token: write`, uses a GitHub-hosted runner, and does not
reference an `NPM_TOKEN`. It also verifies npm CLI `>=11.5.1`, the minimum npm
currently documents for OIDC publishing. Trusted publishing automatically
produces provenance for a public package from a public repository.

Reference: [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

The manually published first `0.1.0` package has no CI-generated provenance.
Do not imply otherwise on the `0.1.0` release page. `0.1.1` was the first
version published by `publish.yml`; its npm artifact has OIDC provenance and a
registry signature.

## First GitHub Release (Completed For `v0.1.0`)

`v0.1.0` was published from commit `131c6d9`. Its completed checklist was:

- the `0.1.0` npm package must exist;
- `publish.yml` must be registered as the trusted publisher;
- the release target must be the intended `main` commit;
- the release tag must equal `v<package.json version>`.

Publishing the release triggered `publish.yml`. The workflow found the manually
published package, skipped a duplicate npm publish, and finished successfully.
This did not retroactively add provenance to `0.1.0`.

## Later Releases

1. Update the version and changelog in one focused commit.
2. Push to `main` and wait for CI.
3. Create a GitHub Release whose tag exactly matches `v<package.json version>`.
4. Publish the release.
5. Verify the npm package, provenance, GitHub Actions run, and installation on a
   clean Apple Silicon Mac.
6. Publish the matching `server.json` version to the official MCP Registry and
   verify that it becomes the latest active version.

The release workflow is intentionally idempotent: if the exact package version
already exists, it does not attempt to overwrite it.

## Publish To The Official MCP Registry

The repository includes `server.json`, and `package.json.mcpName` matches its
server identity. The MCP Registry verifies this field from the public npm
artifact, so registry publication must happen after the npm package exists.

`io.github.millerchou/strava-mcp-bridge@0.1.0` and `@0.1.1` are published to the
official Registry; `0.1.1` is the latest active version at the time of writing.
Publishing to npm or creating a GitHub Release does not update the MCP Registry
automatically. Repeat this section for every package version.

1. Confirm the npm package and `server.json` versions match.
2. Install the official `mcp-publisher` CLI using the current registry docs.
3. Authenticate interactively:

   ```bash
   mcp-publisher login github
   ```

4. Publish from the repository root:

   ```bash
   mcp-publisher publish
   ```

5. Verify the registry record before submitting the project to downstream MCP
   directories.

Reference: [official MCP Registry quickstart](https://modelcontextprotocol.io/registry/quickstart).

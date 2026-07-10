"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function writeStreamFileAtomic({ directory, activityId, streams }) {
  ensureSecureDirectory(directory);
  const outputFile = path.join(directory, `${activityId}.json`);
  assertSafeExistingFile(outputFile);

  const temporaryFile = path.join(
    directory,
    `.${activityId}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const flags = fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(temporaryFile, flags, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(streams)}\n`, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryFile, outputFile);
    fs.chmodSync(outputFile, 0o600);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
  return outputFile;
}

function ensureSecureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("stream output path must be a real directory, not a symlink");
  }
  assertOwnedByCurrentUser(stat, "stream output directory");
  fs.chmodSync(directory, 0o700);
}

function assertSafeExistingFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("existing stream target must be a regular file, not a symlink");
  }
  assertOwnedByCurrentUser(stat, "existing stream target");
}

function assertOwnedByCurrentUser(stat, label) {
  if (typeof process.getuid !== "function") return;
  if (stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

function pruneStreamFiles({
  directory,
  olderThanDays,
  remove = false,
  nowMs = Date.now(),
}) {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error("olderThanDays must be a non-negative number");
  }
  if (!fs.existsSync(directory)) {
    return { directory, olderThanDays, dryRun: !remove, files: [] };
  }
  ensureSecureDirectory(directory);

  const cutoffMs = nowMs - olderThanDays * 24 * 60 * 60 * 1000;
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!/^\d+\.json$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
    const filePath = path.join(directory, entry.name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    assertOwnedByCurrentUser(stat, "stream file");
    if (stat.mtimeMs > cutoffMs) continue;
    files.push(filePath);
  }
  files.sort();

  if (remove) {
    for (const filePath of files) {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`refusing to remove changed stream path: ${filePath}`);
      }
      assertOwnedByCurrentUser(stat, "stream file");
      fs.unlinkSync(filePath);
    }
  }
  return { directory, olderThanDays, dryRun: !remove, files };
}

module.exports = {
  ensureSecureDirectory,
  pruneStreamFiles,
  writeStreamFileAtomic,
};

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pruneStreamFiles, writeStreamFileAtomic } = require("../src/stream_store");

test("atomic stream writes replace regular files without leaving temporary files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "strava-stream-store-"));
  writeStreamFileAtomic({ directory, activityId: "123", streams: { time: [0] } });
  writeStreamFileAtomic({ directory, activityId: "123", streams: { time: [0, 1] } });

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "123.json"), "utf8")), {
    time: [0, 1],
  });
  assert.deepEqual(fs.readdirSync(directory), ["123.json"]);
  assert.equal(fs.statSync(path.join(directory, "123.json")).mode & 0o777, 0o600);
});

test("stream pruning ignores symlinks and non-numeric filenames", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "strava-stream-prune-"));
  const directory = path.join(parent, "streams");
  fs.mkdirSync(directory);
  const oldFile = path.join(directory, "123.json");
  const currentFile = path.join(directory, "456.json");
  const ignored = path.join(directory, "metadata.json");
  const victim = path.join(parent, "victim.json");
  fs.writeFileSync(oldFile, "{}\n");
  fs.writeFileSync(currentFile, "{}\n");
  fs.writeFileSync(ignored, "{}\n");
  fs.writeFileSync(victim, "keep\n");
  fs.symlinkSync(victim, path.join(directory, "789.json"));
  fs.utimesSync(oldFile, new Date(0), new Date(0));

  const dryRun = pruneStreamFiles({
    directory,
    olderThanDays: 1,
    nowMs: Date.now(),
  });
  assert.deepEqual(dryRun.files, [oldFile]);
  assert.equal(fs.existsSync(oldFile), true);

  const removed = pruneStreamFiles({
    directory,
    olderThanDays: 1,
    remove: true,
    nowMs: Date.now(),
  });
  assert.deepEqual(removed.files, [oldFile]);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(currentFile), true);
  assert.equal(fs.existsSync(ignored), true);
  assert.equal(fs.readFileSync(victim, "utf8"), "keep\n");
});

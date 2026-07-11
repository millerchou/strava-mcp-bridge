"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODEX_SKILL_NAME = "strava-mcp-bridge";

function bundledCodexSkillPath({ packageRoot = path.resolve(__dirname, "..") } = {}) {
  return path.join(packageRoot, ".agents", "skills", CODEX_SKILL_NAME);
}

function codexSkillTarget({ homeDir = os.homedir(), projectDir } = {}) {
  const skillRoot = projectDir
    ? path.join(path.resolve(projectDir), ".agents", "skills")
    : path.join(path.resolve(homeDir), ".agents", "skills");
  return path.join(skillRoot, CODEX_SKILL_NAME);
}

function installCodexSkill({
  sourceDir = bundledCodexSkillPath(),
  homeDir = os.homedir(),
  projectDir,
  force = false,
} = {}) {
  assertSkillSource(sourceDir);

  const targetDir = codexSkillTarget({ homeDir, projectDir });
  const scope = projectDir ? "project" : "user";
  const targetExists = fs.existsSync(targetDir);

  if (targetExists && directoriesEqual(sourceDir, targetDir)) {
    return {
      changed: false,
      scope,
      sourceDir,
      targetDir,
    };
  }

  if (targetExists && !force) {
    throw new Error(
      `Codex skill already exists with different content at ${targetDir}. ` +
      "Re-run with --force only after reviewing that directory.",
    );
  }

  const parentDir = path.dirname(targetDir);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o755 });

  const suffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temporaryDir = path.join(parentDir, `.${CODEX_SKILL_NAME}.install-${suffix}`);
  const backupDir = path.join(parentDir, `.${CODEX_SKILL_NAME}.backup-${suffix}`);
  let movedExisting = false;

  try {
    fs.cpSync(sourceDir, temporaryDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });

    if (targetExists) {
      fs.renameSync(targetDir, backupDir);
      movedExisting = true;
    }

    fs.renameSync(temporaryDir, targetDir);
  } catch (error) {
    if (fs.existsSync(temporaryDir)) {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
    if (movedExisting && !fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, targetDir);
    }
    throw error;
  }

  if (fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }

  return {
    changed: true,
    scope,
    sourceDir,
    targetDir,
  };
}

function assertSkillSource(sourceDir) {
  const stat = fs.statSync(sourceDir, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Bundled Codex skill directory not found: ${sourceDir}`);
  }

  const skillFile = path.join(sourceDir, "SKILL.md");
  const skillStat = fs.statSync(skillFile, { throwIfNoEntry: false });
  if (!skillStat || !skillStat.isFile()) {
    throw new Error(`Bundled Codex skill is missing SKILL.md: ${sourceDir}`);
  }

  snapshotDirectory(sourceDir, { rejectSymlinks: true });
}

function directoriesEqual(leftDir, rightDir) {
  let left;
  let right;
  try {
    left = snapshotDirectory(leftDir, { rejectSymlinks: true });
    right = snapshotDirectory(rightDir);
  } catch {
    return false;
  }

  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const candidate = right[index];
    if (entry.relativePath !== candidate.relativePath || entry.type !== candidate.type) {
      return false;
    }
    if (Buffer.isBuffer(entry.content) && Buffer.isBuffer(candidate.content)) {
      return entry.content.equals(candidate.content);
    }
    return entry.content === candidate.content;
  });
}

function snapshotDirectory(rootDir, { rejectSymlinks = false } = {}) {
  const entries = [];

  function visit(directory, relativeDirectory) {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.join(relativeDirectory, child.name);

      if (child.isSymbolicLink()) {
        if (rejectSymlinks) {
          throw new Error(`Codex skill must not contain symlinks: ${absolutePath}`);
        }
        entries.push({ relativePath, type: "symlink", content: fs.readlinkSync(absolutePath) });
        continue;
      }

      if (child.isDirectory()) {
        entries.push({ relativePath, type: "directory", content: null });
        visit(absolutePath, relativePath);
        continue;
      }

      if (child.isFile()) {
        entries.push({ relativePath, type: "file", content: fs.readFileSync(absolutePath) });
        continue;
      }

      entries.push({ relativePath, type: "other", content: null });
    }
  }

  visit(rootDir, "");
  return entries;
}

module.exports = {
  CODEX_SKILL_NAME,
  bundledCodexSkillPath,
  codexSkillTarget,
  installCodexSkill,
};

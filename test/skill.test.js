"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  bundledCodexSkillPath,
  codexSkillTarget,
  installCodexSkill,
} = require("../src/skill");

test("bundled Codex skill uses the standard repository location and metadata", () => {
  const sourceDir = bundledCodexSkillPath();
  const skill = fs.readFileSync(path.join(sourceDir, "SKILL.md"), "utf8");

  assert.match(sourceDir, /\.agents\/skills\/strava-mcp-bridge$/);
  assert.match(skill, /^---\nname: strava-mcp-bridge\ndescription:/);
  assert.equal(fs.existsSync(path.join(sourceDir, "agents", "openai.yaml")), true);
});

test("installs the Codex skill to user scope and treats an identical copy as current", (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "strava-skill-home-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const installed = installCodexSkill({ homeDir });
  assert.equal(installed.changed, true);
  assert.equal(installed.scope, "user");
  assert.equal(installed.targetDir, codexSkillTarget({ homeDir }));
  assert.equal(fs.existsSync(path.join(installed.targetDir, "SKILL.md")), true);

  const repeated = installCodexSkill({ homeDir });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.targetDir, installed.targetDir);
});

test("does not overwrite a changed skill unless force is explicit", (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "strava-skill-force-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const installed = installCodexSkill({ homeDir });
  const skillFile = path.join(installed.targetDir, "SKILL.md");
  fs.writeFileSync(skillFile, "locally modified\n");

  assert.throws(
    () => installCodexSkill({ homeDir }),
    /already exists with different content/,
  );
  assert.equal(fs.readFileSync(skillFile, "utf8"), "locally modified\n");

  const updated = installCodexSkill({ homeDir, force: true });
  assert.equal(updated.changed, true);
  assert.match(fs.readFileSync(skillFile, "utf8"), /^---\nname: strava-mcp-bridge/);
});

test("installs the Codex skill into project scope", (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "strava-skill-project-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  const result = installCodexSkill({ projectDir });
  assert.equal(result.scope, "project");
  assert.equal(
    result.targetDir,
    path.join(projectDir, ".agents", "skills", "strava-mcp-bridge"),
  );
  assert.equal(fs.existsSync(path.join(result.targetDir, "SKILL.md")), true);
});

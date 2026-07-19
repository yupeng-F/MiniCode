import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_PATHS } from "../../config/harness-paths.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("归档目录和根入口满足 Harness 布局契约", () => {
  assert.equal(existsSync(join(root, HARNESS_PATHS.docs)), true);
  assert.equal(existsSync(join(root, HARNESS_PATHS.templates)), true);
  assert.equal(existsSync(join(root, HARNESS_PATHS.taskRules)), true);
  assert.equal(existsSync(join(root, ".agent")), true);
  assert.equal(existsSync(join(root, ".gemini")), true);
  assert.equal(existsSync(join(root, "tools/harness")), true);
  assert.equal(existsSync(join(root, "templates")), false);
});

function collectTextFiles(directory) {
  const files = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.isDirectory()) files.push(...collectTextFiles(path));
    else if (statSync(join(root, path)).size < 512_000) files.push(path);
  }
  return files;
}

test("受控配置和脚本不再引用已归档的根路径", () => {
  const files = [
    "AGENTS.md",
    ".agent",
    ".gemini",
    "config",
    "docs",
    "lint",
    "scripts",
    "tools",
  ].flatMap((path) => (statSync(join(root, path)).isDirectory() ? collectTextFiles(path) : [path]));
  const oldDocPath = /docs\/(?:CICD|CODE_REVIEW|CODING_BACKEND|CODING_FRONTEND|DESIGN|GOLDEN_RULES|MIGRATION|OBSERVABILITY|PRODUCT_ACCEPTANCE|PRODUCT_SENSE|QUALITY_SCORE|RELEASE|SECRETS|SPRINT|TECH_BACKEND|TECH_FRONTEND|TEST_CASES|UI_DESIGN_SYSTEM)\.md/;
  const oldTemplatePath = /(?<!\.harness\/framework\/)templates\//;
  const stale = files.filter((path) => {
    if (path.startsWith("docs/superpowers/")) return false;
    const text = readFileSync(join(root, path), "utf8");
    return oldDocPath.test(text) || oldTemplatePath.test(text);
  });
  assert.deepEqual(stale, []);
});

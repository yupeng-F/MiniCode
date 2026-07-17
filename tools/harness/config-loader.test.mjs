import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadHarnessConfig, validateHarnessConfig } from "./config-loader.mjs";

test("配置文件不存在时给出中文错误", () => {
  const root = mkdtempSync(join(tmpdir(), "minicode-config-"));
  assert.throws(() => loadHarnessConfig(root), /缺少配置文件/);
});

test("拒绝空命令阶段", () => {
  assert.throws(
    () => validateHarnessConfig({ version: 1, commands: { test: [] }, overlay: {} }),
    /命令阶段 test 不能为空/,
  );
});

test("加载结构有效的配置", () => {
  const root = mkdtempSync(join(tmpdir(), "minicode-config-"));
  mkdirSync(join(root, "config"));
  writeFileSync(
    join(root, "config", "minicode-harness.yml"),
    "version: 1\ncommands:\n  test:\n    - executable: python\n      args: [-m, pytest]\noverlay:\n  task_rules: lint/task-rules.yml\n  task_overrides:\n    code:\n      spec-backend: MINICODE_BACKEND.md\n",
  );
  const config = loadHarnessConfig(root);
  assert.equal(config.commands.test[0].executable, "python");
});

test("安全审计固定使用官方 registry", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const config = loadHarnessConfig(root);
  const audit = config.commands.lint.find(
    (command) => command.executable === "npm" && command.args.includes("audit"),
  );

  assert.ok(audit);
  assert.equal(audit.args.includes("--registry=https://registry.npmjs.org"), true);
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { runHarnessAction } from "../harness-check.mjs";
import { applyOverlay, mergeHarnessOverrides } from "./overlay.mjs";

const rules = {
  version: "1.6",
  tasks: {
    code: { "spec-backend": "CODING_BACKEND.md", acceptance: ["旧验收"] },
    observe: { spec: "OBSERVABILITY.md" },
  },
};

test("只覆盖声明字段并保留无关任务", () => {
  const result = mergeHarnessOverrides(rules, {}, {
    code: { "spec-backend": "MINICODE_BACKEND.md", acceptance: ["pnpm test 通过"] },
  });
  assert.equal(result.tasks.code["spec-backend"], "MINICODE_BACKEND.md");
  assert.deepEqual(result.tasks.code.acceptance, ["pnpm test 通过"]);
  assert.deepEqual(result.tasks.observe, rules.tasks.observe);
  assert.notEqual(result.tasks.observe, rules.tasks.observe);
});

test("递归合并根级和任务对象，数组整体替换", () => {
  const result = mergeHarnessOverrides(
    {
      ...rules,
      sprint_preflight: { command: "旧命令", ttl_seconds: 60 },
      tasks: {
        ...rules.tasks,
        code: { ...rules.tasks.code, tools: { allow: ["search"], deny: ["docker"] } },
      },
    },
    { sprint_preflight: { command: "pnpm typecheck" } },
    { code: { tools: { allow: ["search", "bash"] } } },
  );

  assert.deepEqual(result.sprint_preflight, { command: "pnpm typecheck", ttl_seconds: 60 });
  assert.deepEqual(result.tasks.code.tools, { allow: ["search", "bash"], deny: ["docker"] });
});

test("覆盖未知任务时拒绝写入", () => {
  assert.throws(
    () => mergeHarnessOverrides(rules, {}, { missing: { spec: "X.md" } }),
    /未知 Harness 任务/,
  );
});

test("缺少 tasks 文档时拒绝覆盖", () => {
  assert.throws(() => mergeHarnessOverrides({ version: "1.6" }, {}, {}), /缺少 tasks/);
});

test("重复覆盖得到相同结果", () => {
  const overrides = { code: { "spec-backend": "MINICODE_BACKEND.md" } };
  const rootOverrides = { sprint_preflight: { command: "pnpm typecheck" } };
  const once = mergeHarnessOverrides(rules, rootOverrides, overrides);
  const twice = mergeHarnessOverrides(once, rootOverrides, overrides);
  assert.deepEqual(twice, once);
});

test("只写 MiniCode 的 lint/task-rules.yml 并保留末尾换行", () => {
  const root = mkdtempSync(join(tmpdir(), "minicode-overlay-"));
  mkdirSync(join(root, "lint"));
  writeFileSync(
    join(root, "lint", "task-rules.yml"),
    "version: '1.6'\ntasks:\n  code:\n    spec-backend: CODING_BACKEND.md\n",
  );
  const config = {
    overlay: {
      task_rules: "lint/task-rules.yml",
      root_overrides: { sprint_preflight: { command: "pnpm typecheck" } },
      task_overrides: { code: { "spec-backend": "MINICODE_BACKEND.md" } },
    },
  };

  applyOverlay(root, config);

  const source = readFileSync(join(root, "lint", "task-rules.yml"), "utf8");
  assert.equal(source.endsWith("\n"), true);
  const document = parse(source);
  assert.equal(document.sprint_preflight.command, "pnpm typecheck");
  assert.equal(document.tasks.code["spec-backend"], "MINICODE_BACKEND.md");
});

test("拒绝覆盖 lint/task-rules.yml 之外的路径", () => {
  const root = mkdtempSync(join(tmpdir(), "minicode-overlay-"));
  const config = {
    overlay: {
      task_rules: "docs/task-rules.yml",
      task_overrides: {},
    },
  };

  assert.throws(() => applyOverlay(root, config), /只能写入 lint\/task-rules\.yml/);
});

test("拒绝通过 lint 目录符号链接写到 MiniCode 根外", () => {
  const root = mkdtempSync(join(tmpdir(), "minicode-overlay-"));
  const outside = mkdtempSync(join(tmpdir(), "minicode-overlay-outside-"));
  const outsideRules = join(outside, "task-rules.yml");
  const original = "version: '1.6'\ntasks:\n  code:\n    spec-backend: CODING_BACKEND.md\n";
  writeFileSync(outsideRules, original);
  symlinkSync(outside, join(root, "lint"), "dir");
  const config = {
    overlay: {
      task_rules: "lint/task-rules.yml",
      task_overrides: { code: { "spec-backend": "MINICODE_BACKEND.md" } },
    },
  };

  assert.throws(() => applyOverlay(root, config), /符号链接.*拒绝写入/);
  assert.equal(readFileSync(outsideRules, "utf8"), original);
});

test("拒绝通过 task-rules 文件符号链接写到 MiniCode 根外", () => {
  const root = mkdtempSync(join(tmpdir(), "minicode-overlay-"));
  const outside = mkdtempSync(join(tmpdir(), "minicode-overlay-outside-"));
  const outsideRules = join(outside, "outside-rules.yml");
  const original = "version: '1.6'\ntasks:\n  code:\n    spec-backend: CODING_BACKEND.md\n";
  mkdirSync(join(root, "lint"));
  writeFileSync(outsideRules, original);
  symlinkSync(outsideRules, join(root, "lint", "task-rules.yml"), "file");
  const config = {
    overlay: {
      task_rules: "lint/task-rules.yml",
      task_overrides: { code: { "spec-backend": "MINICODE_BACKEND.md" } },
    },
  };

  assert.throws(() => applyOverlay(root, config), /符号链接.*拒绝写入/);
  assert.equal(readFileSync(outsideRules, "utf8"), original);
});

test("CLI overlay 分发应用覆盖并输出中文结果", () => {
  const root = mkdtempSync(join(tmpdir(), "minicode-overlay-"));
  mkdirSync(join(root, "lint"));
  writeFileSync(
    join(root, "lint", "task-rules.yml"),
    "version: '1.6'\ntasks:\n  code:\n    spec-backend: CODING_BACKEND.md\n",
  );
  const config = {
    commands: {},
    overlay: {
      task_rules: "lint/task-rules.yml",
      task_overrides: { code: { "spec-backend": "MINICODE_BACKEND.md" } },
    },
  };
  const output = [];

  const status = runHarnessAction(root, config, "overlay", { log: (message) => output.push(message) });

  assert.equal(status, 0);
  assert.deepEqual(output, ["MiniCode Harness 覆盖已应用"]);
});

test("根脚本暴露 Harness overlay 和 doctor 命令", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.scripts["harness:overlay"], "node tools/harness-check.mjs overlay");
  assert.equal(packageJson.scripts["harness:doctor"], "node tools/harness-check.mjs doctor");
});

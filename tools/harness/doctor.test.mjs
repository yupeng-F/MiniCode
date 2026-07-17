import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runHarnessAction } from "../harness-check.mjs";
import { inspectHarness } from "./doctor.mjs";

const requiredSpecs = [
  "ARCHITECTURE.md",
  "PROJECT_RULES.md",
  "USER_STORIES.md",
  "docs/MINICODE_BACKEND.md",
  "docs/MINICODE_FRONTEND.md",
  "docs/MINICODE_TESTING.md",
];

const config = {
  commands: {
    typecheck: [{ executable: "node", args: ["--version"] }],
  },
  overlay: {
    task_rules: "lint/task-rules.yml",
    root_overrides: {
      sprint_preflight: { command: "pnpm typecheck" },
    },
    task_overrides: {
      "backend-design": { spec: "MINICODE_BACKEND.md" },
      "frontend-design": { spec: "MINICODE_FRONTEND.md" },
      code: {
        "spec-backend": "MINICODE_BACKEND.md",
        "spec-frontend": "MINICODE_FRONTEND.md",
        infra_ready: "pnpm typecheck",
      },
      "test-case-gen": { spec: "MINICODE_TESTING.md" },
      quality: { spec: "MINICODE_TESTING.md", infra_ready: "pnpm typecheck" },
    },
  },
};

function createRoot() {
  return mkdtempSync(join(tmpdir(), "minicode-doctor-"));
}

function createSpecs(root) {
  for (const path of requiredSpecs) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `# ${path}\n`);
  }
}

function writeTaskRules(root, acceptance = "MiniCode 规则已应用") {
  mkdirSync(join(root, "lint"), { recursive: true });
  writeFileSync(
    join(root, "lint", "task-rules.yml"),
    `version: "1.6"
sprint_preflight:
  command: pnpm typecheck
tasks:
  backend-design:
    spec: MINICODE_BACKEND.md
  frontend-design:
    spec: MINICODE_FRONTEND.md
  code:
    spec-backend: MINICODE_BACKEND.md
    spec-frontend: MINICODE_FRONTEND.md
    infra_ready: pnpm typecheck
    acceptance:
      - ${acceptance}
  test-case-gen:
    spec: MINICODE_TESTING.md
  quality:
    spec: MINICODE_TESTING.md
    infra_ready: pnpm typecheck
`,
  );
}

test("缺少 task-rules 时诊断失败且不创建文件", () => {
  const root = createRoot();
  const before = readdirSync(root);

  const report = inspectHarness(root, config);

  assert.equal(report.ok, false);
  assert.match(report.checks.find((item) => !item.ok).message, /尚未安装 Harness/);
  assert.deepEqual(readdirSync(root), before);
});

test("空 task-rules 不能被诊断为健康", () => {
  const root = createRoot();
  createSpecs(root);
  mkdirSync(join(root, "lint"));
  writeFileSync(join(root, "lint", "task-rules.yml"), "");

  const report = inspectHarness(root, config);

  assert.equal(report.ok, false);
  assert.match(report.checks.map((item) => item.message).join("\n"), /缺少 tasks/);
});

test("仍引用 Vue 或 Fastify 时诊断失败且不改写规则", () => {
  const root = createRoot();
  createSpecs(root);
  writeTaskRules(root, "Vue3 前端与 Fastify 后端通过验收");
  const path = join(root, "lint", "task-rules.yml");
  const before = readFileSync(path, "utf8");

  const report = inspectHarness(root, config);

  assert.equal(report.ok, false);
  assert.match(report.checks.map((item) => item.message).join("\n"), /覆盖层尚未生效/);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("规范与覆盖全部有效时诊断通过", () => {
  const root = createRoot();
  createSpecs(root);
  writeTaskRules(root);

  const report = inspectHarness(root, config);

  assert.equal(report.ok, true);
  assert.equal(report.checks.every((item) => item.ok), true);
  assert.match(report.checks.find((item) => item.name === "task-rules").message, /任务覆盖已生效/);
});

test("配置命令的 executable 不在 PATH 时诊断失败", () => {
  const root = createRoot();
  createSpecs(root);
  writeTaskRules(root);
  const missingCommandConfig = {
    ...config,
    commands: {
      test: [{ executable: "minicode-command-that-does-not-exist", args: [] }],
    },
  };

  const report = inspectHarness(root, missingCommandConfig);

  assert.equal(report.ok, false);
  assert.match(report.checks.map((item) => item.message).join("\n"), /PATH.*不可用/);
});

test("Docker 型 infra_ready 尚未覆盖时诊断失败", () => {
  const root = createRoot();
  createSpecs(root);
  writeTaskRules(root);
  const path = join(root, "lint", "task-rules.yml");
  const source = readFileSync(path, "utf8").replace(
    "infra_ready: pnpm typecheck",
    "infra_ready: docker compose up",
  );
  writeFileSync(path, source);

  const report = inspectHarness(root, config);

  assert.equal(report.ok, false);
  assert.match(report.checks.map((item) => item.message).join("\n"), /Docker.*覆盖层尚未生效/);
});

test("CLI doctor 逐项输出 PASS 或 FAIL 并传播失败状态", () => {
  const root = createRoot();
  createSpecs(root);
  writeTaskRules(root, "Vue3 前端与 Fastify 后端通过验收");
  const output = [];

  const status = runHarnessAction(root, config, "doctor", { log: (message) => output.push(message) });

  assert.equal(status, 1);
  assert.equal(output.some((message) => message.startsWith("PASS")), true);
  assert.equal(output.some((message) => message.startsWith("FAIL")), true);
});

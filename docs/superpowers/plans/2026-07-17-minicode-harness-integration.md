# MiniCode Harness 接入实施计划

> **供 Agent 执行：** 必须使用 `superpowers:subagent-driven-development`（推荐）或
> `superpowers:executing-plans`，逐任务实施本计划。所有步骤使用复选框跟踪。

**目标：** 在不修改 `/Users/fish/Code/harness` 的前提下，为 MiniCode 增加可扩展的
Node.js Harness 命令适配器、Python/React 项目规范覆盖层，并完成 Harness 安装验证。

**架构：** MiniCode 根目录通过 pnpm 暴露 Harness 固定命令，
`tools/harness-check.mjs` 将命令分发到配置加载、子进程执行、任务规则覆盖和只读诊断
四个模块。`config/minicode-harness.yml` 是命令与覆盖规则的单一真相源；每次 Harness
同步后执行 `pnpm harness:overlay && pnpm harness:doctor` 恢复并验证 MiniCode 语义。

**技术栈：** Node.js ES Modules、Node Test Runner、pnpm、YAML、Python 3.11、pytest、
mypy、Ruff、FastAPI TestClient、React、TypeScript、ESLint、Vitest、Vite。

## 全局约束

- 不修改 `/Users/fish/Code/harness` 中任何文件。
- 新增文档、实施计划、项目说明和代码注释统一使用中文。
- 技术标识符、命令、文件路径和 API 名称保持英文。
- 注释解释设计原因、安全边界和非显然行为，不逐行翻译代码。
- 自动化测试不调用真实模型，不读取真实 API Key，不读取用户级 MiniCode 状态。
- 每个生产行为先写失败测试，确认失败原因正确后再写最小实现。
- `doctor` 必须只读；覆盖程序只能写 MiniCode 内的 `lint/task-rules.yml`。
- Web 继续使用 npm 和 `web/package-lock.json`；根目录 pnpm 仅作为 Harness 入口。

---

## 文件结构

实施后新增或修改的文件职责如下：

```text
package.json                              # Harness 面向的根命令入口
pnpm-lock.yaml                            # 根适配器依赖锁
config/minicode-harness.yml               # 命令与任务覆盖的单一真相源
tools/harness-check.mjs                   # CLI 入口
tools/harness/config-loader.mjs           # 配置加载与结构校验
tools/harness/command-runner.mjs          # 子进程执行与退出码传播
tools/harness/overlay.mjs                 # task-rules.yml 确定性覆盖
tools/harness/doctor.mjs                  # 只读接入诊断
tools/harness/config-loader.test.mjs       # 配置测试
tools/harness/command-runner.test.mjs      # 执行器测试
tools/harness/overlay.test.mjs             # 覆盖测试
tools/harness/doctor.test.mjs              # 诊断测试
ARCHITECTURE.md                            # Harness 架构入口
PROJECT_RULES.md                           # MiniCode 项目规则
USER_STORIES.md                            # MiniCode 产品待办
docs/MINICODE_BACKEND.md                   # Python/FastAPI 规范
docs/MINICODE_FRONTEND.md                  # React/Vite 规范
docs/MINICODE_TESTING.md                   # 测试与证据规范
pyproject.toml                             # Python 开发工具配置
tests/test_harness_smoke.py                # CLI/Web 离线冒烟
web/package.json                           # Web typecheck/lint 命令
web/package-lock.json                      # Web 新依赖锁
web/eslint.config.js                       # React/TypeScript Lint 配置
```

---

### 任务 1：建立根命令入口和配置加载器

**文件：**

- 新建：`package.json`
- 新建：`config/minicode-harness.yml`
- 新建：`tools/harness/config-loader.mjs`
- 新建：`tools/harness/config-loader.test.mjs`

**接口：**

- 输入：MiniCode 仓库根路径。
- 输出：`loadHarnessConfig(root)` 返回已校验的 `{version, commands, overlay}`。
- 错误：配置缺失、版本不支持、命令数组为空或任务覆盖缺失时抛出中文错误。

- [ ] **步骤 1：创建根包清单，只提供适配器开发测试入口**

新增 `package.json`：

```json
{
  "name": "minicode-harness-adapter",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.31.0",
  "scripts": {
    "test:harness": "node --test tools/harness/*.test.mjs"
  },
  "dependencies": {
    "yaml": "^2.8.1"
  }
}
```

- [ ] **步骤 2：安装根依赖并生成锁文件**

执行：

```bash
pnpm install
```

预期：生成 `pnpm-lock.yaml`，输出中没有安装失败。

- [ ] **步骤 3：先写配置加载失败测试**

新增 `tools/harness/config-loader.test.mjs`，至少包含以下行为：

```javascript
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
```

- [ ] **步骤 4：运行测试并确认按预期失败**

执行：

```bash
pnpm test:harness
```

预期：FAIL，错误指出 `config-loader.mjs` 不存在或未导出目标函数。

- [ ] **步骤 5：实现最小配置加载器**

新增 `tools/harness/config-loader.mjs`，实现：

```javascript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export function validateHarnessConfig(value) {
  if (!value || value.version !== 1) throw new Error("minicode-harness.yml 版本必须为 1");
  if (!value.commands || typeof value.commands !== "object") throw new Error("缺少 commands 配置");
  for (const [phase, commands] of Object.entries(value.commands)) {
    if (!Array.isArray(commands) || commands.length === 0) throw new Error(`命令阶段 ${phase} 不能为空`);
    for (const command of commands) {
      if (!command?.executable || !Array.isArray(command.args)) throw new Error(`命令阶段 ${phase} 的命令结构无效`);
    }
  }
  if (!value.overlay?.task_rules) throw new Error("缺少 overlay.task_rules 配置");
  if (!value.overlay?.task_overrides || typeof value.overlay.task_overrides !== "object") {
    throw new Error("缺少 overlay.task_overrides 配置");
  }
  return value;
}

export function loadHarnessConfig(root) {
  const path = join(root, "config", "minicode-harness.yml");
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`缺少配置文件：${path}`, { cause: error });
  }
  return validateHarnessConfig(parse(source));
}
```

- [ ] **步骤 6：写入初始配置**

新增 `config/minicode-harness.yml`。命令必须按以下内容声明：

```yaml
version: 1

commands:
  typecheck:
    - executable: python
      args: [-m, mypy, src/minicode]
    - executable: npm
      args: [--prefix, web, run, typecheck]
  lint:
    - executable: python
      args: [-m, ruff, check, src/minicode, tests]
    - executable: python
      args: [-m, pip, check]
    - executable: npm
      args: [--prefix, web, run, lint]
    - executable: npm
      args: [--prefix, web, audit, --audit-level=high]
  test:
    - executable: python
      args: [-m, pytest]
    - executable: npm
      args: [--prefix, web, test]
  build:
    - executable: python
      args: [-m, build, --wheel]
    - executable: npm
      args: [--prefix, web, run, build]
  test:e2e:
    - executable: python
      args: [-m, pytest, tests/test_harness_smoke.py]

overlay:
  task_rules: lint/task-rules.yml
  root_overrides:
    sprint_preflight:
      command: pnpm typecheck
      ttl_seconds: 1800
      on_failure: 展示失败证据并停止任务，修复后重新执行
  task_overrides:
    design:
      specs: [DESIGN.md, MINICODE_FRONTEND.md]
      acceptance:
        - 设计符合 MiniCode React 界面与现有视觉语言
        - 主路径、异常路径、加载状态和审批状态完整
        - 设计结果可以通过 Web 测试或后续 Playwright 场景验证
    backend-design:
      spec: MINICODE_BACKEND.md
      tools:
        allow: [file-rw, search, explore]
      acceptance:
        - 后端方案符合 FastAPI、Pydantic 与 SQLite 项目约束
        - 工具副作用必须经过 MiniCode Harness Runtime
        - 接口、持久化和错误路径均有可验证设计
    frontend-design:
      spec: MINICODE_FRONTEND.md
      specs: [MINICODE_FRONTEND.md]
      tools:
        allow: [file-rw, search, explore, chrome-devtools, webapp-testing]
      acceptance:
        - 前端方案使用 React、TypeScript 与 Vite
        - API 调用集中在 web/src/api.ts
        - 可访问性、错误状态和构建验证完整
    code:
      spec-backend: MINICODE_BACKEND.md
      spec-frontend: MINICODE_FRONTEND.md
      specs-frontend: [MINICODE_FRONTEND.md]
      tools:
        allow: [file-rw, search, bash, sub-agent, chrome-devtools, webapp-testing]
      infra_ready: pnpm typecheck
      acceptance:
        - pnpm typecheck、pnpm lint、pnpm test 全部通过
        - MiniCode Runtime 安全不变式未被绕过
        - 新增或变更行为有自动化测试
    test-case-gen:
      spec: MINICODE_TESTING.md
    quality:
      spec: MINICODE_TESTING.md
      entry_command: pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e
      infra_ready: pnpm typecheck
      acceptance:
        - entry_command 退出码为 0
        - Python、Web、构建和离线冒烟证据完整
        - 质量报告记录每条命令的真实结果
```

- [ ] **步骤 7：运行配置测试并确认通过**

执行：

```bash
pnpm test:harness
```

预期：3 个配置测试 PASS。

- [ ] **步骤 8：提交任务 1**

```bash
git add package.json pnpm-lock.yaml config/minicode-harness.yml tools/harness/config-loader.mjs tools/harness/config-loader.test.mjs
git commit -m "feat: add MiniCode Harness adapter config"
```

---

### 任务 2：实现可测试的命令执行器和 CLI 分发

**文件：**

- 新建：`tools/harness/command-runner.mjs`
- 新建：`tools/harness/command-runner.test.mjs`
- 新建：`tools/harness-check.mjs`
- 修改：`package.json`

**接口：**

- `runCommand(command, options)` 执行一个结构化命令并返回退出码。
- `runPhase(config, phase, options)` 顺序执行阶段命令，首个失败立即停止。
- CLI 支持 `typecheck|lint|test|build|test:e2e`。

- [ ] **步骤 1：先写快速失败和退出码传播测试**

新增 `tools/harness/command-runner.test.mjs`：

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { runPhase } from "./command-runner.mjs";

test("阶段命令顺序执行", () => {
  const calls = [];
  const spawn = (executable, args) => {
    calls.push([executable, args]);
    return { status: 0 };
  };
  const status = runPhase(
    { commands: { test: [
      { executable: "python", args: ["-m", "pytest"] },
      { executable: "npm", args: ["--prefix", "web", "test"] },
    ] } },
    "test",
    { spawn },
  );
  assert.equal(status, 0);
  assert.deepEqual(calls.map(([name]) => name), ["python", "npm"]);
});

test("首个失败后停止并传播退出码", () => {
  const calls = [];
  const spawn = (executable) => {
    calls.push(executable);
    return { status: executable === "python" ? 7 : 0 };
  };
  const status = runPhase(
    { commands: { lint: [
      { executable: "python", args: ["-m", "ruff"] },
      { executable: "npm", args: ["run", "lint"] },
    ] } },
    "lint",
    { spawn },
  );
  assert.equal(status, 7);
  assert.deepEqual(calls, ["python"]);
});

test("未知阶段返回配置错误", () => {
  assert.throws(() => runPhase({ commands: {} }, "missing"), /未知命令阶段/);
});
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm test:harness
```

预期：新测试因 `command-runner.mjs` 不存在而 FAIL。

- [ ] **步骤 3：实现最小命令执行器**

新增 `tools/harness/command-runner.mjs`：

```javascript
import { spawnSync } from "node:child_process";

export function runCommand(command, { spawn = spawnSync, cwd = process.cwd() } = {}) {
  const result = spawn(command.executable, command.args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw new Error(`无法执行命令 ${command.executable}：${result.error.message}`);
  return result.status ?? 1;
}

export function runPhase(config, phase, options = {}) {
  const commands = config.commands[phase];
  if (!commands) throw new Error(`未知命令阶段：${phase}`);
  for (const command of commands) {
    const status = runCommand(command, options);
    if (status !== 0) return status;
  }
  return 0;
}
```

- [ ] **步骤 4：实现 CLI 入口**

新增 `tools/harness-check.mjs`。入口必须：解析仓库根目录、加载配置、分发普通阶段，
捕获异常并以中文输出到 stderr。首版暂不实现 `overlay` 和 `doctor`，但未知命令必须失败。

核心分发逻辑：

```javascript
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnessConfig } from "./harness/config-loader.mjs";
import { runPhase } from "./harness/command-runner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const phase = process.argv[2];

try {
  if (!phase) throw new Error("请指定 Harness 检查阶段");
  const config = loadHarnessConfig(root);
  process.exitCode = runPhase(config, phase, { cwd: root });
} catch (error) {
  console.error(`Harness 适配器失败：${error.message}`);
  process.exitCode = 1;
}
```

- [ ] **步骤 5：扩展根脚本**

在 `package.json` 增加：

```json
"typecheck": "node tools/harness-check.mjs typecheck",
"lint": "node tools/harness-check.mjs lint",
"test": "node tools/harness-check.mjs test",
"build": "node tools/harness-check.mjs build",
"test:e2e": "node tools/harness-check.mjs test:e2e"
```

- [ ] **步骤 6：运行 Node 单元测试**

```bash
pnpm test:harness
```

预期：配置与命令执行器测试全部 PASS。

- [ ] **步骤 7：提交任务 2**

```bash
git add package.json tools/harness-check.mjs tools/harness/command-runner.mjs tools/harness/command-runner.test.mjs
git commit -m "feat: add fail-fast Harness command runner"
```

---

### 任务 3：实现任务规则覆盖和只读 Doctor

**文件：**

- 新建：`tools/harness/overlay.mjs`
- 新建：`tools/harness/overlay.test.mjs`
- 新建：`tools/harness/doctor.mjs`
- 新建：`tools/harness/doctor.test.mjs`
- 修改：`tools/harness-check.mjs`
- 修改：`package.json`

**接口：**

- `mergeHarnessOverrides(document, rootOverrides, taskOverrides)` 返回覆盖后的完整规则对象。
- `applyOverlay(root, config)` 只写配置指定的 MiniCode `lint/task-rules.yml`。
- `inspectHarness(root, config)` 返回 `{ok, checks}`，不得写文件。

- [ ] **步骤 1：先写覆盖合并、未知任务和幂等测试**

`tools/harness/overlay.test.mjs` 使用临时目录和最小 YAML：

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { mergeHarnessOverrides } from "./overlay.mjs";

const rules = {
  version: "1.6",
  tasks: {
    code: { spec-backend: "CODING_BACKEND.md", acceptance: ["旧验收"] },
    observe: { spec: "OBSERVABILITY.md" },
  },
};

test("只覆盖声明字段并保留无关任务", () => {
  const result = mergeHarnessOverrides(rules, {}, {
    code: { spec-backend: "MINICODE_BACKEND.md", acceptance: ["pnpm test 通过"] },
  });
  assert.equal(result.tasks.code["spec-backend"], "MINICODE_BACKEND.md");
  assert.deepEqual(result.tasks.code.acceptance, ["pnpm test 通过"]);
  assert.deepEqual(result.tasks.observe, rules.tasks.observe);
});

test("覆盖未知任务时拒绝写入", () => {
  assert.throws(
    () => mergeHarnessOverrides(rules, {}, { missing: { spec: "X.md" } }),
    /未知 Harness 任务/,
  );
});

test("重复覆盖得到相同结果", () => {
  const overrides = { code: { spec-backend: "MINICODE_BACKEND.md" } };
  const rootOverrides = { sprint_preflight: { command: "pnpm typecheck" } };
  const once = mergeHarnessOverrides(rules, rootOverrides, overrides);
  const twice = mergeHarnessOverrides(once, rootOverrides, overrides);
  assert.deepEqual(twice, once);
});
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm test:harness
```

预期：overlay 测试因模块不存在而 FAIL。

- [ ] **步骤 3：实现覆盖模块**

`mergeHarnessOverrides` 必须深拷贝输入、验证 `tasks`、验证每个覆盖任务已存在；先递归
合并根级覆盖，再合并任务覆盖。数组整体替换，对象字段递归合并，标量直接替换。

`applyOverlay` 必须：

1. 用 `resolve(root, config.overlay.task_rules)` 解析目标。
2. 校验目标仍位于 `root` 内，且规范化相对路径精确为 `lint/task-rules.yml`。
3. 读取和解析 YAML。
4. 调用 `mergeHarnessOverrides`。
5. 使用 YAML `stringify` 写回并确保文件末尾有换行。

- [ ] **步骤 4：先写 Doctor 只读检查测试**

`tools/harness/doctor.test.mjs` 覆盖：

```javascript
test("缺少 task-rules 时诊断失败", () => {
  const report = inspectHarness(root, config);
  assert.equal(report.ok, false);
  assert.match(report.checks.find((item) => !item.ok).message, /尚未安装 Harness/);
});

test("仍引用 Vue 或 Fastify 时诊断失败", () => {
  // 临时 task-rules.yml 的 acceptance 写入 Vue3 和 Fastify。
  const report = inspectHarness(root, config);
  assert.equal(report.ok, false);
  assert.match(report.checks.map((item) => item.message).join("\n"), /覆盖层尚未生效/);
});

test("规范与覆盖全部有效时诊断通过", () => {
  // 创建六份必需规范和已经覆盖的最小 task-rules.yml。
  const report = inspectHarness(root, config);
  assert.equal(report.ok, true);
});
```

- [ ] **步骤 5：运行测试并确认失败**

```bash
pnpm test:harness
```

预期：doctor 测试因模块不存在而 FAIL。

- [ ] **步骤 6：实现只读 Doctor**

`inspectHarness` 检查：

- `lint/task-rules.yml` 是否存在。
- `ARCHITECTURE.md`、`PROJECT_RULES.md`、`USER_STORIES.md`、
  `docs/MINICODE_BACKEND.md`、`docs/MINICODE_FRONTEND.md`、
  `docs/MINICODE_TESTING.md` 是否存在。
- `backend-design`、`frontend-design`、`code`、`test-case-gen`、`quality` 是否引用
  MiniCode 规范。
- 根级 `sprint_preflight.command` 是否为 MiniCode 命令，`code` 和 `quality` 的
  `infra_ready` 是否不再要求 Docker。
- 这些任务序列化后的内容是否仍出现 `Vue`、`Fastify`、`Drizzle` 或 `Pinia`。
- 配置中每个命令的 executable 是否能通过 `PATH` 定位；检查仅探测，不执行任务命令。

返回值固定为：

```javascript
{
  ok: checks.every((item) => item.ok),
  checks: [{ name: "task-rules", ok: true, message: "任务覆盖已生效" }],
}
```

- [ ] **步骤 7：接入 CLI 与根脚本**

`tools/harness-check.mjs` 增加：

- `overlay` 调用 `applyOverlay(root, config)`，成功输出“MiniCode Harness 覆盖已应用”。
- `doctor` 调用 `inspectHarness(root, config)`，逐项输出 `PASS/FAIL`；存在失败项时退出 1。

`package.json` 增加：

```json
"harness:overlay": "node tools/harness-check.mjs overlay",
"harness:doctor": "node tools/harness-check.mjs doctor"
```

- [ ] **步骤 8：运行全部 Node 测试**

```bash
pnpm test:harness
```

预期：配置、执行器、覆盖和 Doctor 测试全部 PASS。

- [ ] **步骤 9：提交任务 3**

```bash
git add package.json tools/harness-check.mjs tools/harness/overlay.mjs tools/harness/overlay.test.mjs tools/harness/doctor.mjs tools/harness/doctor.test.mjs
git commit -m "feat: add MiniCode Harness overlay and doctor"
```

---

### 任务 4：建立 MiniCode 项目规范单一真相源

**文件：**

- 新建：`ARCHITECTURE.md`
- 新建：`PROJECT_RULES.md`
- 新建：`USER_STORIES.md`
- 新建：`docs/MINICODE_BACKEND.md`
- 新建：`docs/MINICODE_FRONTEND.md`
- 新建：`docs/MINICODE_TESTING.md`
- 修改：`AGENTS.md`

**接口：**

- Harness Agent 通过标准文件名加载项目事实。
- `docs/01_项目目标与架构设计.md` 继续作为详细产品架构真源，避免重复。

- [ ] **步骤 1：编写 `ARCHITECTURE.md`**

必须包含：

- 项目定位：本地优先 Agentic Coding Assistant。
- 技术栈：Python 3.11、FastAPI、Pydantic、SQLite、React、TypeScript、Vite。
- 七层目录：interfaces、application、engine、context、runtime、tools、memory/observability。
- 依赖方向：interfaces → application → engine/runtime/context；工具只能经 Runtime 执行。
- 安全不变式：工作区边界、默认只读、副作用审批、Artifact 落盘。
- 详细架构链接：`docs/01_项目目标与架构设计.md`。
- 明确区分 Harness Engineering 与 MiniCode Harness Runtime。

- [ ] **步骤 2：编写 `PROJECT_RULES.md`**

必须明确：

- Python 公共接口必须有类型注解；外部输入使用 Pydantic 校验。
- `interfaces` 不直接执行工具，`tools` 不绕过 `runtime`。
- 文件写入、Shell、Git 写操作必须通过 PolicyEngine 与 ApprovalGate。
- 工作区外路径拒绝，敏感目录不可读取。
- React API 请求只通过 `web/src/api.ts`。
- 修改行为必须先写测试；禁止真实模型进入默认测试。
- 提交前执行 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`。

- [ ] **步骤 3：编写三份专项规范**

`docs/MINICODE_BACKEND.md` 必须包含：

- FastAPI 路由只做输入输出适配，业务编排进入 application/engine。
- Pydantic Schema、统一 HTTP 错误、SQLite 事务边界。
- QueryLoop 暂停/恢复、Approval API 和并发状态要求。
- Runtime/Policy/Workspace 的不可绕过约束。
- pytest 测试要求和完成定义。

`docs/MINICODE_FRONTEND.md` 必须包含：

- React 函数组件、TypeScript strict、Vite。
- API Client 集中、会话轮询清理、错误/空/加载/审批状态。
- 可访问性：键盘操作、可见焦点、语义标签。
- 不强制 Vue、Pinia、Tailwind；保持现有 MiniCode 视觉语言。
- Vitest、typecheck、lint、build 完成定义。

`docs/MINICODE_TESTING.md` 必须包含：

- 单元、集成、冒烟、后续 Playwright 四层测试。
- pytest 与 Vitest 的职责边界。
- Mock 只替代模型和外部服务，不替代 Runtime 安全决策。
- 临时目录/临时 SQLite 隔离。
- 默认测试离线；真实模型测试必须显式标记并单独运行。
- 当前门禁命令和失败证据格式。

- [ ] **步骤 4：编写初始 `USER_STORIES.md`**

至少登记以下可交付故事，状态均为 `ready`：

- US-001：可靠的 Glob/Grep/Read 仓库检索。
- US-002：可预览、审批和应用的 Patch 工作流。
- US-003：SQLite 持久化的审批暂停与恢复。
- US-004：Web UI 展示工具调用、结果和审批状态。
- US-005：上下文压缩和 Artifact 引用。

每个 Story 至少三条可自动验证的验收标准，粒度必须可在一个 Feature Sprint 完成。

- [ ] **步骤 5：更新 `AGENTS.md` 导航**

在推荐阅读顺序中增加 `ARCHITECTURE.md`、`PROJECT_RULES.md`、`USER_STORIES.md`，在
项目约束中增加“新增文档与代码注释使用中文”。不得删除现有 Tool-Use Loop、Runtime、
Context、Memory 架构说明。

- [ ] **步骤 6：运行文档基础检查**

```bash
python -c "from pathlib import Path; required=['ARCHITECTURE.md','PROJECT_RULES.md','USER_STORIES.md','docs/MINICODE_BACKEND.md','docs/MINICODE_FRONTEND.md','docs/MINICODE_TESTING.md']; missing=[p for p in required if not Path(p).is_file()]; assert not missing, missing"
rg -n "TODO|TBD|待定" ARCHITECTURE.md PROJECT_RULES.md USER_STORIES.md docs/MINICODE_*.md
```

预期：Python 命令退出 0；`rg` 无匹配并以 1 退出，表示不存在占位符。

- [ ] **步骤 7：提交任务 4**

```bash
git add AGENTS.md ARCHITECTURE.md PROJECT_RULES.md USER_STORIES.md docs/MINICODE_BACKEND.md docs/MINICODE_FRONTEND.md docs/MINICODE_TESTING.md
git commit -m "docs: add MiniCode Harness project specifications"
```

---

### 任务 5：接入 Python/Web 工具链和离线冒烟测试

**文件：**

- 修改：`pyproject.toml`
- 新建：`tests/test_harness_smoke.py`
- 修改：`web/package.json`
- 修改：`web/package-lock.json`
- 新建：`web/eslint.config.js`

**接口：**

- Python 开发环境提供 `mypy`、`ruff`、`build`。
- Web 提供 `npm --prefix web run typecheck` 和 `npm --prefix web run lint`。
- 冒烟测试离线验证 CLI 与 Web 入口。

- [ ] **步骤 1：先写 CLI/Web 冒烟测试**

新增 `tests/test_harness_smoke.py`：

```python
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from minicode.interfaces.web.server import app


def test_cli_mock_mode_completes_in_temporary_workspace(tmp_path: Path) -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "minicode.interfaces.cli",
            "--mock",
            "--workspace",
            str(tmp_path),
            "检查工作区",
        ],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, "MINICODE_HOME": str(tmp_path / ".home")},
    )
    assert result.returncode == 0, result.stderr
    assert "MiniCode mock query loop completed." in result.stdout


def test_web_index_uses_temporary_global_store(tmp_path: Path) -> None:
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    response = TestClient(app).get("/")
    assert response.status_code == 200
    assert response.json() == {
        "name": "MiniCode",
        "architecture": "Tool-Use Loop + Harness Runtime + Context Management + Markdown Memory",
    }
```

- [ ] **步骤 2：运行现有行为表征测试**

```bash
pnpm test:e2e
```

预期：2 个测试 PASS，因为 CLI Mock 模式与 Web 根接口均为已有行为。如果测试失败，先确认
是否暴露既有缺陷；若是，则保留当前失败作为 RED 证据，增加更精确的回归断言后再修复，
不得为了让接入通过而删除断言。

- [ ] **步骤 3：增加 Python 开发依赖和保守基线配置**

在 `pyproject.toml` 的 `dev` 依赖增加：

```toml
"build>=1.2.2",
"mypy>=1.11.0",
"ruff>=0.6.0",
```

增加：

```toml
[tool.mypy]
python_version = "3.11"
check_untyped_defs = true
ignore_missing_imports = true
warn_unused_ignores = true

[tool.ruff]
target-version = "py311"
line-length = 120

[tool.ruff.lint]
select = ["E9", "F63", "F7", "F82"]
```

这一步只启用会导致运行错误的 Ruff 规则，后续 Sprint 再扩大风格规则，避免在接入任务中
混入无关格式化修改。

- [ ] **步骤 4：安装 Python 开发依赖**

```bash
python -m pip install -e '.[dev]'
```

预期：安装成功，`python -m mypy --version` 与 `python -m ruff --version` 均退出 0。

- [ ] **步骤 5：增加 Web 类型检查与 ESLint**

在 `web/package.json` scripts 增加：

```json
"typecheck": "tsc --noEmit",
"lint": "eslint src --max-warnings=0"
```

安装最小依赖：

```bash
npm --prefix web install --save-dev @eslint/js eslint globals typescript-eslint
```

新增 `web/eslint.config.js`：

```javascript
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
);
```

- [ ] **步骤 6：安装工具链后重新运行冒烟测试**

```bash
pnpm test:e2e
```

预期：2 个测试 PASS，且没有真实模型或 API Key 请求。

- [ ] **步骤 7：逐个运行根命令并修复真实阻塞**

按顺序执行：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

预期：四个命令全部退出 0。只允许修复命令暴露的真实类型、Lint、测试或构建问题；不得
降低配置标准或跳过失败子命令。任何代码修复都必须先补充能复现问题的测试。

- [ ] **步骤 8：运行适配器单元测试**

```bash
pnpm test:harness
```

预期：所有 Node 单元测试 PASS。

- [ ] **步骤 9：提交任务 5**

```bash
git add pyproject.toml tests/test_harness_smoke.py web/package.json web/package-lock.json web/eslint.config.js
git commit -m "build: connect Python and Web Harness checks"
```

---

### 任务 6：安装 Harness、应用覆盖并验证接入

**文件：**

- 由安装器新增：MiniCode 内的共享 `docs/`、`lint/`、`scripts/`、CI 模板和项目目录。
- 由覆盖器修改：`lint/task-rules.yml`。
- 不修改：`/Users/fish/Code/harness`。

**接口：**

- Harness 安装器只作为外部只读来源。
- MiniCode 通过 `overlay` 恢复技术栈语义，通过 `doctor` 提供最终接入判定。

- [ ] **步骤 1：确认两个仓库的前置状态**

```bash
git -C /Users/fish/Code/MiniCode status --short
git -C /Users/fish/Code/harness status --short
```

预期：两个命令均无输出。若 Harness 有用户修改，停止安装并报告，不得覆盖或提交。

- [ ] **步骤 2：执行安装预览**

```bash
cd /Users/fish/Code/harness
./install.sh --dry-run /Users/fish/Code/MiniCode
```

预期：列出将同步的文件，不修改 MiniCode，不创建提交，不推送。

- [ ] **步骤 3：执行无提交安装**

```bash
cd /Users/fish/Code/harness
./install.sh --no-commit /Users/fish/Code/MiniCode
```

预期：安装成功；MiniCode 出现预期共享文件；Harness 工作区仍无修改。

- [ ] **步骤 4：重新应用项目覆盖**

```bash
cd /Users/fish/Code/MiniCode
pnpm harness:overlay
```

预期：输出“MiniCode Harness 覆盖已应用”。连续执行第二次仍成功，第二次不产生额外
语义变化。

- [ ] **步骤 5：运行只读 Doctor**

```bash
pnpm harness:doctor
```

预期：所有检查 PASS；MiniCode 任务规则不再包含 Vue/Fastify/Drizzle/Pinia 验收假设。

- [ ] **步骤 6：运行安装后的完整验证**

```bash
pnpm test:harness
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
node scripts/validate-task-rules.mjs
node scripts/doc-lint.mjs
```

预期：所有命令退出 0。若 Harness 文档检查发现安装器自带文档问题，只记录明确证据，
不得修改 Harness 源文件；MiniCode 项目文档问题必须在本分支修复。

- [ ] **步骤 7：审查安装 Diff**

```bash
git status --short
git diff --check
git diff --stat
git diff -- lint/task-rules.yml
git -C /Users/fish/Code/harness status --short
```

预期：MiniCode 无空白错误；`task-rules.yml` 指向 MiniCode 规范；Harness 状态无输出。

- [ ] **步骤 8：提交 Harness 安装结果**

```bash
git add .
git commit -m "chore: install Harness Engineering framework"
```

- [ ] **步骤 9：最终验证提交状态**

```bash
git status --short
git log --oneline --decorate -8
git -C /Users/fish/Code/harness status --short
```

预期：MiniCode 工作区干净；提交历史保留设计、适配器、规范、工具链和安装的独立提交；
Harness 工作区干净。

---

## 计划自检清单

- [ ] 设计文档中的命令适配、规范覆盖、Doctor、安全和交付顺序均有对应任务。
- [ ] 每个新行为都安排了先失败、后实现、再通过的测试步骤。
- [ ] 所有文件路径、函数名、脚本名和配置字段在前后任务中一致。
- [ ] 没有修改 Harness 源代码的步骤。
- [ ] 没有真实模型、真实 API Key 或用户级状态依赖。
- [ ] 文档和代码注释语言约束已经进入全局约束和项目规范任务。

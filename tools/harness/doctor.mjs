import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";

const REQUIRED_SPECS = [
  "ARCHITECTURE.md",
  "PROJECT_RULES.md",
  "USER_STORIES.md",
  "docs/MINICODE_BACKEND.md",
  "docs/MINICODE_FRONTEND.md",
  "docs/MINICODE_TESTING.md",
];

const TASK_SPECS = {
  "backend-design": ["MINICODE_BACKEND.md"],
  "frontend-design": ["MINICODE_FRONTEND.md"],
  code: ["MINICODE_BACKEND.md", "MINICODE_FRONTEND.md"],
  "test-case-gen": ["MINICODE_TESTING.md"],
  quality: ["MINICODE_TESTING.md"],
};

const LEGACY_STACK_PATTERN = /Vue|Fastify|Drizzle|Pinia/i;

function check(name, ok, successMessage, failureMessage) {
  return { name, ok, message: ok ? successMessage : failureMessage };
}

function canExecute(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableOnPath(executable) {
  if (isAbsolute(executable) || executable.includes("/")) return canExecute(executable);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => extensions.some((extension) => canExecute(join(directory, `${executable}${extension}`))));
}

function commandChecks(config) {
  const executables = new Set(
    Object.values(config.commands ?? {})
      .flat()
      .map((command) => command?.executable)
      .filter(Boolean),
  );
  return [...executables].map((executable) => {
    const ok = executableOnPath(executable);
    return check(
      `command:${executable}`,
      ok,
      `命令 ${executable} 可通过 PATH 定位`,
      `命令 ${executable} 在 PATH 中不可用`,
    );
  });
}

function inspectTaskRules(document, config) {
  const checks = [];
  const tasks = document?.tasks;
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) {
    return [check("task-specs", false, "", "任务规则缺少 tasks 对象，覆盖层尚未生效")];
  }

  for (const [taskName, expectedSpecs] of Object.entries(TASK_SPECS)) {
    const serialized = JSON.stringify(tasks[taskName] ?? {});
    const ok = expectedSpecs.every((spec) => serialized.includes(spec));
    checks.push(
      check(
        `task-spec:${taskName}`,
        ok,
        `任务 ${taskName} 已引用 MiniCode 规范`,
        `任务 ${taskName} 未引用 MiniCode 规范，覆盖层尚未生效`,
      ),
    );
  }

  const expectedPreflight = config.overlay?.root_overrides?.sprint_preflight?.command;
  const preflightOk = Boolean(expectedPreflight) && document.sprint_preflight?.command === expectedPreflight;
  checks.push(
    check(
      "sprint-preflight",
      preflightOk,
      "Sprint 预检已使用 MiniCode 命令",
      "Sprint 预检未使用 MiniCode 命令，覆盖层尚未生效",
    ),
  );

  for (const taskName of ["code", "quality"]) {
    const actual = tasks[taskName]?.infra_ready;
    const expected = config.overlay?.task_overrides?.[taskName]?.infra_ready;
    const usesDocker = typeof actual === "string" && /docker/i.test(actual);
    const ok = Boolean(expected) && actual === expected && !usesDocker;
    checks.push(
      check(
        `infra-ready:${taskName}`,
        ok,
        `任务 ${taskName} 的环境预检不依赖 Docker`,
        usesDocker
          ? `任务 ${taskName} 仍要求 Docker，覆盖层尚未生效`
          : `任务 ${taskName} 的环境预检未使用 MiniCode 命令，覆盖层尚未生效`,
      ),
    );
  }

  const inspectedTasks = Object.keys(TASK_SPECS).map((taskName) => tasks[taskName] ?? {});
  const containsLegacyStack = LEGACY_STACK_PATTERN.test(JSON.stringify(inspectedTasks));
  checks.push(
    check(
      "legacy-stack",
      !containsLegacyStack,
      "任务规则未引用 Vue、Fastify、Drizzle 或 Pinia",
      "任务规则仍引用 Vue、Fastify、Drizzle 或 Pinia，覆盖层尚未生效",
    ),
  );

  return checks;
}

export function inspectHarness(root, config) {
  const checks = [];
  const normalizedRoot = resolve(root);
  const taskRulesPath = resolve(normalizedRoot, config.overlay?.task_rules ?? "");
  const taskRulesRelativePath = relative(normalizedRoot, taskRulesPath);
  const validTaskRulesPath = taskRulesRelativePath === join("lint", "task-rules.yml");
  const taskRulesExists = validTaskRulesPath && existsSync(taskRulesPath);

  checks.push(
    check(
      "harness-install",
      taskRulesExists,
      "已找到 Harness 任务规则",
      validTaskRulesPath
        ? "尚未安装 Harness：缺少 lint/task-rules.yml"
        : "Harness 配置必须指向 lint/task-rules.yml",
    ),
  );

  const missingSpecs = REQUIRED_SPECS.filter((path) => !existsSync(resolve(normalizedRoot, path)));
  checks.push(
    check(
      "minicode-specs",
      missingSpecs.length === 0,
      "MiniCode 必需规范文件齐全",
      `缺少 MiniCode 必需规范：${missingSpecs.join("、")}`,
    ),
  );
  checks.push(...commandChecks(config));

  if (taskRulesExists) {
    let document;
    let parsed = false;
    try {
      document = parse(readFileSync(taskRulesPath, "utf8"));
      parsed = true;
    } catch (error) {
      checks.push({ name: "task-rules", ok: false, message: `task-rules.yml 无法解析：${error.message}` });
    }
    if (parsed) {
      const ruleChecks = inspectTaskRules(document, config);
      checks.push(...ruleChecks);
      const rulesOk = ruleChecks.every((item) => item.ok);
      checks.push(
        check(
          "task-rules",
          rulesOk,
          "任务覆盖已生效",
          "任务覆盖检查未通过，请查看以上诊断",
        ),
      );
    }
  }

  return {
    ok: checks.every((item) => item.ok),
    checks,
  };
}

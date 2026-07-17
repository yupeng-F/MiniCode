import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
}

function mergeValues(current, overrides) {
  if (!isObject(overrides)) return cloneValue(overrides);
  const result = isObject(current) ? cloneValue(current) : {};
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = mergeValues(result[key], value);
  }
  return result;
}

export function mergeHarnessOverrides(document, rootOverrides = {}, taskOverrides = {}) {
  if (!isObject(document?.tasks)) throw new Error("Harness 任务规则缺少 tasks 对象");
  if (!isObject(rootOverrides)) throw new Error("Harness 根级覆盖必须为对象");
  if (!isObject(taskOverrides)) throw new Error("Harness 任务覆盖必须为对象");

  for (const task of Object.keys(taskOverrides)) {
    if (!Object.hasOwn(document.tasks, task)) throw new Error(`未知 Harness 任务：${task}`);
  }

  const result = mergeValues(document, rootOverrides);
  for (const [task, overrides] of Object.entries(taskOverrides)) {
    result.tasks[task] = mergeValues(result.tasks[task], overrides);
  }
  return result;
}

export function applyOverlay(root, config) {
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, config.overlay.task_rules);
  const targetRelativePath = relative(normalizedRoot, target);
  const expectedRelativePath = join("lint", "task-rules.yml");

  // 覆盖层只拥有 MiniCode 仓库内这一份任务规则文件的写权限。
  if (
    targetRelativePath !== expectedRelativePath ||
    targetRelativePath.startsWith(`..${join("/")}`) ||
    isAbsolute(targetRelativePath)
  ) {
    throw new Error("Harness 覆盖只能写入 lint/task-rules.yml");
  }

  const lintDirectory = resolve(normalizedRoot, "lint");
  if (lstatSync(lintDirectory).isSymbolicLink() || lstatSync(target).isSymbolicLink()) {
    throw new Error("Harness 覆盖检测到符号链接，拒绝写入 lint/task-rules.yml");
  }
  const realRoot = realpathSync(normalizedRoot);
  const realTarget = realpathSync(target);
  if (relative(realRoot, realTarget) !== expectedRelativePath) {
    throw new Error("Harness 覆盖目标真实路径已逃逸 MiniCode 根目录，拒绝写入");
  }

  const document = parse(readFileSync(target, "utf8"));
  const result = mergeHarnessOverrides(
    document,
    config.overlay.root_overrides ?? {},
    config.overlay.task_overrides,
  );
  const source = stringify(result);
  writeFileSync(target, source.endsWith("\n") ? source : `${source}\n`);
  return result;
}

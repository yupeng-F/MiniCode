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

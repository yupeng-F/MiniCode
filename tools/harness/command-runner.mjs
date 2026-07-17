import { spawnSync } from "node:child_process";

export function runCommand(command, { spawn = spawnSync, cwd = process.cwd() } = {}) {
  const result = spawn(command.executable, command.args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
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

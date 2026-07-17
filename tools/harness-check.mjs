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

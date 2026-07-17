import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnessConfig } from "./harness/config-loader.mjs";
import { runPhase } from "./harness/command-runner.mjs";
import { inspectHarness } from "./harness/doctor.mjs";
import { applyOverlay } from "./harness/overlay.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");

export function runHarnessAction(actionRoot, config, phase, { log = console.log } = {}) {
  if (!phase) throw new Error("请指定 Harness 检查阶段");
  if (phase === "overlay") {
    applyOverlay(actionRoot, config);
    log("MiniCode Harness 覆盖已应用");
    return 0;
  }
  if (phase === "doctor") {
    const report = inspectHarness(actionRoot, config);
    for (const item of report.checks) {
      log(`${item.ok ? "PASS" : "FAIL"} ${item.name}：${item.message}`);
    }
    return report.ok ? 0 : 1;
  }
  return runPhase(config, phase, { cwd: actionRoot });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const config = loadHarnessConfig(root);
    process.exitCode = runHarnessAction(root, config, process.argv[2]);
  } catch (error) {
    console.error(`Harness 适配器失败：${error.message}`);
    process.exitCode = 1;
  }
}

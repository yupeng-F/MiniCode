import { existsSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_PATHS } from "../config/harness-paths.mjs";

const root = process.cwd();
const required = [
  HARNESS_PATHS.docs,
  HARNESS_PATHS.templates,
  HARNESS_PATHS.taskRules,
  ".agent",
  ".gemini",
  "tools/harness",
];

const missing = required.filter((path) => !existsSync(join(root, path)));
const legacy = ["templates"].filter((path) => existsSync(join(root, path)));

if (missing.length > 0 || legacy.length > 0) {
  if (missing.length > 0) console.error(`缺少 Harness 归档路径：${missing.join(", ")}`);
  if (legacy.length > 0) console.error(`仍存在未归档路径：${legacy.join(", ")}`);
  process.exit(1);
}

console.log("Harness 归档布局通过");

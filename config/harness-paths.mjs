/**
 * Harness 资产路径的单一真相源。
 * 运行入口仍保留在仓库根目录，只有可归档的静态资产使用独立目录。
 */
export const HARNESS_PATHS = Object.freeze({
  docs: "docs/harness",
  templates: ".harness/framework/templates",
  taskRules: "lint/task-rules.yml",
  scripts: "scripts",
});

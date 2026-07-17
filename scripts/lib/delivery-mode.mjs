// 此文件是 MAI-Harness 框架的一部分，请勿在项目中修改，请在框架工程中修改，并覆盖到此项目中。
// =============================================================================
// HARNESS_DELIVERY_MODE 解析器
//
// Sprint 13 T-07 已完成移除 HARNESS_REGISTRY_MODE 环境变量兼容层（BREAKING）。
// 历史上 Sprint 12 引入 HARNESS_DELIVERY_MODE 替代 HARNESS_REGISTRY_MODE，
// 经一个 Sprint 的 deprecate-warn 期后，于 Sprint 13 T-07 删除运行时识别。
// 仍保留旧函数名 export `resolveRegistryMode`（指向同一实现）以避免下游 import 名 SyntaxError。
//
// environments.yml 的旧 key `entry.registry_mode` 仍被识别（warn）作为最低 yml 兼容；
// 该 key 的最终移除留待未来 Long-term Watch（无明确 Sprint 计划）。
//
// 解析优先级：
//   1. process.env.HARNESS_DELIVERY_MODE  （唯一识别的环境变量）
//   2. entry.delivery_mode                 （environments.yml 新 key）
//   3. entry.registry_mode                 （environments.yml 旧 key，warn）
//   4. 'artifact'                          （Phase 1 默认）
//
// 用法:
//   import { resolveDeliveryMode } from './lib/delivery-mode.mjs';
//   const mode = resolveDeliveryMode(envEntry); // 'registry' | 'artifact'
// =============================================================================

import { fatal, warn } from './utils.mjs';

const VALID_MODES = ['registry', 'artifact'];
const DEFAULT_MODE = 'artifact';

export function resolveDeliveryMode(entry = {}) {
  const newName = process.env.HARNESS_DELIVERY_MODE;

  // entries 仍兼容 delivery_mode / registry_mode 双 key（最低 yml 兼容）
  const newEntry = entry?.delivery_mode;
  const oldEntry = entry?.registry_mode;
  if (oldEntry && !newEntry) {
    warn(
      '[deprecated] config/environments.yml 中 registry_mode 已改名为 delivery_mode；'
      + '请尽快迁移（运行时仍兼容）。'
    );
  }
  if (oldEntry && newEntry && oldEntry !== newEntry) {
    fatal(`environments.yml 同名歧义：delivery_mode=${newEntry} vs registry_mode=${oldEntry}`);
  }

  const raw = (newName || newEntry || oldEntry || DEFAULT_MODE).toLowerCase();
  if (!VALID_MODES.includes(raw)) {
    fatal(`未知 HARNESS_DELIVERY_MODE：${raw}（合法值：${VALID_MODES.join(' | ')}）`);
  }
  return raw;
}

// 旧函数名导出别名，兼容现有 import（避免下游 SyntaxError）。
export const resolveRegistryMode = resolveDeliveryMode;

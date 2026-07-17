// 项目特定的 UI 原型对照契约。
// scripts/ui-audit.mjs（Harness 框架文件，不要修改）会动态加载本文件。
//
// 必备导出：
//   - required (boolean)：本项目是否需要 UI 审核（纯后端项目可设 false）
//   - createAuditPlan({ sprintId, runtime, helpers, apiBase, webBase })
//
// 可选导出：
//   - resolveAuditUserId({ sprintId, apiBase, token, fetch })
//   - createMockMatrix({ sprintId, mockBase, fetch })
//
// 契约强度要求（由 scripts/check-contract-strength.mjs 强制）：
//   - 每个 contract.checks 至少 6 项
//   - 同时包含 presence/count、textList、style、metric 四类 helper
//
// 原型覆盖要求（由 scripts/check-prototype-coverage.mjs 强制）：
//   - docs/design-docs/prototypes/sprint-<id>/*.html 每个文件都必须被某个 contract 引用

export const required = true;

function parseSprintNumber(value) {
  const match = value.match(/^(?:sprint-)?(\d+)(?:-.+)?$/);
  return match ? match[1] : value;
}

export async function createAuditPlan({ sprintId, runtime, helpers }) {
  const sprintNumber = parseSprintNumber(sprintId);
  const {
    comparePresence, compareCount, compareStyle, compareTextList, compareMetric,
    DESKTOP_VIEWPORT,
  } = helpers;

  // 模板示例：每个 Sprint 在此分支下追加 contracts。
  if (sprintNumber !== '0') {
    return {
      required: true,
      reason: `Sprint ${sprintId} 尚未在 lint/ui-contracts.mjs 声明 UI 原型对照计划`,
      contracts: [],
    };
  }

  return {
    required: true,
    contracts: [
      {
        name: 'ExamplePage',
        designRef: '示例页面 / 默认状态',
        prototype: {
          path: 'docs/design-docs/prototypes/sprint-0-example/example.html',
          readySelector: '.page',
        },
        live: {
          path: '/example',
          readySelector: '.example-page',
        },
        screenshotName: 'example-default.png',
        viewport: DESKTOP_VIEWPORT,
        checks: [
          comparePresence('页头', '.page .header', '.example-page .header'),
          compareCount('卡片数量', '.page .card', '.example-page .card'),
          compareTextList('卡片标题顺序', '.page .card h3', '.example-page .card__title'),
          compareStyle('卡片背景', '.page .card', '.example-page .card', 'backgroundColor'),
          compareStyle('标题字号', '.page .header h1', '.example-page .header h1', 'fontSize'),
          compareMetric('卡片圆角', '.page .card', '.example-page .card', 'borderTopLeftRadius'),
        ],
      },
    ],
  };
}

// 可选：声明数据矩阵覆盖。check-mock-fixtures.mjs 会逐项 fetch 并断言 expectField 出现 requiredValues。
// export async function createMockMatrix({ sprintId }) {
//   return [
//     {
//       label: 'message-kinds',
//       endpoint: 'http://localhost:3001/api/mock/seed-sessions/sample/messages',
//       expectField: 'data.messages[*].messageType',
//       requiredValues: ['text', 'image', 'voice', 'video', 'file'],
//     },
//   ];
// }

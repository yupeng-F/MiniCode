#!/usr/bin/env node
// 此文档是 MAI-Harness 框架的一部分，请勿在项目中修改。
// =============================================================================
// check-mock-fixtures.mjs
//
// 校验：lint/ui-contracts.mjs 可声明 mockMatrix（数据形态矩阵），脚本会
// 实际请求 mock 端点验证响应中包含全部声明的"内容类型/状态"标识。
//
// 用法：node scripts/check-mock-fixtures.mjs --sprint <N-name> [--mock-base url]
// 退出码：0 = 全覆盖或未声明矩阵，1 = 矩阵声明缺项
//
// lint/ui-contracts.mjs 中可选导出：
//   export async function createMockMatrix({ sprintId, mockBase, fetch }) {
//     return [
//       {
//         label: 'chat 消息类型',
//         endpoint: `${mockBase}/api/sessions/.../messages`,
//         expectField: 'data.messages[*].type',
//         requiredValues: ['text', 'image', 'voice', 'video', 'file'],
//       },
//     ];
//   }
// =============================================================================

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { err, info, ok, parseArgs } from './lib/utils.mjs';

const { options } = parseArgs(process.argv.slice(2), { options: ['--sprint', '--mock-base'] });
const sprintId = options.get('--sprint');
if (!sprintId) {
  err('--sprint 参数必填');
  process.exit(1);
}
const mockBase = options.get('--mock-base') || process.env.MOCK_SERVER_URL || 'http://localhost:3001';

const candidate = resolve(process.cwd(), 'lint/ui-contracts.mjs');
if (!existsSync(candidate)) {
  ok('lint/ui-contracts.mjs 不存在，跳过 mock 矩阵检查');
  process.exit(0);
}

const projectModule = await import(pathToFileURL(candidate).href);
if (typeof projectModule.createMockMatrix !== 'function') {
  ok('lint/ui-contracts.mjs 未声明 createMockMatrix()，跳过（请确认本 Sprint 无需数据矩阵覆盖）');
  process.exit(0);
}

const matrix = await projectModule.createMockMatrix({ sprintId, mockBase, fetch });
if (!Array.isArray(matrix) || matrix.length === 0) {
  ok('createMockMatrix() 返回空，跳过');
  process.exit(0);
}

let failures = 0;
for (const entry of matrix) {
  const { label, endpoint, expectField, requiredValues } = entry;
  if (!endpoint || !expectField || !Array.isArray(requiredValues)) {
    err(`✘ ${label}: 矩阵声明缺字段（endpoint/expectField/requiredValues）`);
    failures += 1;
    continue;
  }
  let body;
  try {
    // eslint-disable-next-line no-await-in-loop -- 串行请求避免压垮 mock
    const res = await fetch(endpoint);
    if (!res.ok) {
      err(`✘ ${label}: ${endpoint} HTTP ${res.status}`);
      failures += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    body = await res.json();
  } catch (e) {
    err(`✘ ${label}: 请求失败 ${e?.message || e}`);
    failures += 1;
    continue;
  }
  const actual = new Set(extractByPath(body, expectField).filter(Boolean));
  const missing = requiredValues.filter((v) => !actual.has(v));
  if (missing.length > 0) {
    err(`✘ ${label}: 缺少值 ${JSON.stringify(missing)}（实际 ${JSON.stringify([...actual])}）`);
    failures += 1;
  } else {
    info(`✔ ${label}: 全部 ${requiredValues.length} 个值在 mock 中可见`);
  }
}

if (failures > 0) {
  err(`${failures} 项 mock 矩阵未达声明覆盖`);
  process.exit(1);
}
ok('mock 矩阵全部覆盖');
process.exit(0);

function extractByPath(root, path) {
  // 极简 JSONPath：支持 a.b[*].c
  const parts = path.split('.');
  let cursor = [root];
  for (const part of parts) {
    const next = [];
    const m = part.match(/^([^[]+)(\[\*])?$/);
    if (!m) return [];
    const key = m[1];
    const wildcard = !!m[2];
    for (const c of cursor) {
      if (c == null) continue;
      const v = c[key];
      if (wildcard) {
        if (Array.isArray(v)) next.push(...v);
      } else {
        next.push(v);
      }
    }
    cursor = next;
  }
  return cursor;
}

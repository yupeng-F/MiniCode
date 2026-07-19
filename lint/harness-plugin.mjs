/**
 * eslint-plugin-harness — Harness Engineering 自定义 ESLint 规则
 *
 * H-01: 分层架构强制执行 (layer-imports)
 * H-02: 编码约束强制执行 (no-hardcoded-secrets, no-sql-concatenation)
 * H-03: 所有错误消息包含修复指令 + 规范引用
 * H-17: 黄金原则 Lint 化 (no-magic-values, no-duplicate-helper)
 *
 * 零依赖，纯 JS AST 分析，兼容任何 ESLint parser。
 */

// ─── 分层架构定义 ───────────────────────────────────────────────────────────────
// 文件后缀 → 层级映射（可通过项目约定覆盖）
const LAYER_PATTERNS = {
  ctrl:   /\.ctrl\.[jt]sx?$/,
  svc:    /\.svc\.[jt]sx?$/,
  repo:   /\.repo\.[jt]sx?$/,
  types:  /(?:^|\/)types\.[jt]sx?$/,
  config: /(?:^|\/)config\.[jt]sx?$/,
};

const LAYER_DISPLAY = {
  ctrl: 'Controller', svc: 'Service', repo: 'Repository',
  types: 'Types', config: 'Config',
};

// 每层允许导入的层（同层 + 下列清单 + providers/shared）
const ALLOWED_IMPORTS = {
  ctrl:   ['svc', 'types', 'config'],
  svc:    ['repo', 'types', 'config'],
  repo:   ['types', 'config'],
  types:  [],
  config: [],
};

// Service 层禁止导入的 HTTP 框架模块
const HTTP_MODULES = [
  'fastify', 'express', 'koa', 'hapi', 'http', 'https',
  '@fastify/', '@hono/', 'hono', 'next/server',
];

// ─── 检测函数 ───────────────────────────────────────────────────────────────────

function detectLayer(filePath) {
  for (const [name, pattern] of Object.entries(LAYER_PATTERNS)) {
    if (pattern.test(filePath)) return name;
  }
  return null;
}

function detectImportLayer(importSource) {
  if (/\.ctrl\b/.test(importSource)) return 'ctrl';
  if (/\.svc\b/.test(importSource)) return 'svc';
  if (/\.repo\b/.test(importSource)) return 'repo';
  if (/(?:^|\/)types$/.test(importSource) || /\/types['"]/.test(importSource)) return 'types';
  if (/(?:^|\/)config$/.test(importSource) || /\/config['"]/.test(importSource)) return 'config';
  return null;
}

function isHttpModule(source) {
  return HTTP_MODULES.some(mod => source === mod || source.startsWith(mod));
}

function isProviderOrShared(source) {
  return /(?:^|[/\\])(?:providers|shared)(?:[/\\]|$)/.test(source);
}

// ─── 密钥检测模式 ───────────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}['"]/i, name: 'API Key' },
  { pattern: /(?:secret|token|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i, name: 'Secret/Token/Password' },
  { pattern: /AKIA[0-9A-Z]{16}/, name: 'AWS Access Key' },
  { pattern: /gh[ps]_[A-Za-z0-9_]{36,}/, name: 'GitHub Token' },
  { pattern: /(?:key|secret|token|password|credential)\s*[:=]\s*['"][A-Za-z0-9+/=]{32,}['"]/i, name: '硬编码凭据' },
  { pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/, name: '私钥' },
];

// ─── SQL 检测 ────────────────────────────────────────────────────────────────────

const SQL_KEYWORDS = /\b(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|TRUNCATE)\b/i;

// ═══════════════════════════════════════════════════════════════════════════════
// Plugin 定义
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  meta: { name: 'eslint-plugin-harness', version: '1.1.0' },
  rules: {

    // ─── H-01: 分层架构强制执行 ─────────────────────────────────────────────────
    'layer-imports': {
      meta: {
        type: 'problem',
        docs: {
          description: '强制执行分层架构依赖方向：Controller → Service → Repository → Types/Config',
        },
        messages: {
          layerViolation:
            '{{ currentLayer }} 层不允许导入 {{ importLayer }} 层。' +
            '允许的依赖：{{ allowed }}。' +
            '请将此逻辑移至正确层级，或通过 providers/ 接口解耦。' +
            '参考 docs/harness/CODING_BACKEND.md §分层设计 / PROJECT_RULES.md §后端 #8-#10。',
          httpInService:
            'Service 层禁止导入 HTTP 模块「{{ source }}」。' +
            'Service 只处理业务逻辑，不感知传输层（Request/Response）。' +
            '请将 HTTP 操作移至 Controller 层，Service 通过参数接收纯数据。' +
            '参考 docs/harness/CODING_BACKEND.md §分层设计 / PROJECT_RULES.md §后端 #9。',
        },
        schema: [],
      },
      create(context) {
        const filename = context.filename || context.getFilename();
        const currentLayer = detectLayer(filename);
        if (!currentLayer) return {};

        const allowed = ALLOWED_IMPORTS[currentLayer] || [];

        return {
          ImportDeclaration(node) {
            const source = node.source.value;
            if (isProviderOrShared(source)) return;

            // Service 层禁止 HTTP 模块
            if (currentLayer === 'svc' && isHttpModule(source)) {
              context.report({ node, messageId: 'httpInService', data: { source } });
              return;
            }

            // 相对导入的层级违规检查
            if (source.startsWith('.')) {
              const importLayer = detectImportLayer(source);
              if (importLayer && importLayer !== currentLayer && !allowed.includes(importLayer)) {
                context.report({
                  node,
                  messageId: 'layerViolation',
                  data: {
                    currentLayer: LAYER_DISPLAY[currentLayer],
                    importLayer: LAYER_DISPLAY[importLayer],
                    allowed: [currentLayer, ...allowed].map(l => LAYER_DISPLAY[l] || l).join('、'),
                  },
                });
              }
            }
          },
        };
      },
    },

    // ─── H-02: 硬编码密钥检测 ───────────────────────────────────────────────────
    'no-hardcoded-secrets': {
      meta: {
        type: 'problem',
        docs: { description: '禁止在源码中硬编码密钥、API Key、Token、密码' },
        messages: {
          secretDetected:
            '检测到疑似硬编码的{{ type }}。禁止将密钥提交到代码仓库。' +
            '请通过环境变量注入（process.env.XXX），并在 .env.example 中添加占位符（无真实值）。' +
            '参考 docs/harness/CODING_BACKEND.md §密钥管理 / PROJECT_RULES.md §Key Rules #4。',
        },
        schema: [],
      },
      create(context) {
        function check(node, value) {
          if (typeof value !== 'string') return;
          for (const { pattern, name } of SECRET_PATTERNS) {
            if (pattern.test(value)) {
              context.report({ node, messageId: 'secretDetected', data: { type: name } });
              return;
            }
          }
        }
        return {
          Literal(node) { check(node, node.value); },
          TemplateLiteral(node) {
            for (const quasi of node.quasis) { check(node, quasi.value.raw); }
          },
        };
      },
    },

    // ─── H-02: SQL 拼接检测 ─────────────────────────────────────────────────────
    'no-sql-concatenation': {
      meta: {
        type: 'problem',
        docs: { description: '禁止字符串拼接 SQL，必须使用 ORM 参数化查询' },
        messages: {
          sqlConcat:
            '检测到 SQL 字符串拼接，存在 SQL 注入风险。' +
            '数据库查询必须使用 ORM 参数化查询（如 Drizzle/Prisma），禁止字符串拼接 SQL。' +
            '参考 docs/harness/CODING_BACKEND.md §数据安全 / PROJECT_RULES.md §Key Rules #6。',
        },
        schema: [],
      },
      create(context) {
        return {
          TemplateLiteral(node) {
            if (node.expressions.length === 0) return;
            const raw = node.quasis.map(q => q.value.raw).join('__EXPR__');
            if (SQL_KEYWORDS.test(raw)) {
              context.report({ node, messageId: 'sqlConcat' });
            }
          },
          BinaryExpression(node) {
            if (node.operator !== '+') return;
            function hasSQL(n) {
              if (n.type === 'Literal' && typeof n.value === 'string') return SQL_KEYWORDS.test(n.value);
              if (n.type === 'TemplateLiteral') return n.quasis.some(q => SQL_KEYWORDS.test(q.value.raw));
              if (n.type === 'BinaryExpression' && n.operator === '+') return hasSQL(n.left) || hasSQL(n.right);
              return false;
            }
            function hasVar(n) {
              if (n.type === 'Identifier' || n.type === 'MemberExpression' || n.type === 'CallExpression') return true;
              if (n.type === 'BinaryExpression') return hasVar(n.left) || hasVar(n.right);
              return false;
            }
            if ((hasSQL(node.left) || hasSQL(node.right)) && (hasVar(node.left) || hasVar(node.right))) {
              context.report({ node, messageId: 'sqlConcat' });
            }
          },
        };
      },
    },

    // ─── H-17: 魔法数字检测（黄金原则 G-3） ─────────────────────────────────────
    'no-magic-values': {
      meta: {
        type: 'suggestion',
        docs: {
          description: '禁止硬编码魔法数字，业务常量应集中到 config/ 或 shared/constants',
        },
        messages: {
          magicNumber:
            '硬编码数字 {{ value }} 应提取为命名常量。' +
            '业务阈值、配置值应集中到 config/ 或 shared/constants。' +
            '参考 docs/harness/GOLDEN_RULES.md §G-3。',
        },
        schema: [{
          type: 'object',
          properties: {
            ignore: { type: 'array', items: { type: 'number' } },
          },
          additionalProperties: false,
        }],
      },
      create(context) {
        const DEFAULT_IGNORE = [0, 1, -1, 2, 10, 100, 1000];
        const options = context.options[0] || {};
        const ignored = new Set(options.ignore || DEFAULT_IGNORE);

        function isConstDeclaration(node) {
          let parent = node.parent;
          // const X = 42
          while (parent) {
            if (parent.type === 'VariableDeclaration' && parent.kind === 'const') return true;
            if (parent.type === 'Property' || parent.type === 'ArrayExpression') {
              parent = parent.parent;
              continue;
            }
            break;
          }
          return false;
        }

        function isDefaultParam(node) {
          return node.parent && node.parent.type === 'AssignmentPattern';
        }

        function isEnumOrType(node) {
          let p = node.parent;
          while (p) {
            if (p.type === 'TSEnumDeclaration' || p.type === 'TSTypeAliasDeclaration') return true;
            p = p.parent;
          }
          return false;
        }

        return {
          Literal(node) {
            if (typeof node.value !== 'number') return;
            if (ignored.has(node.value)) return;
            if (!Number.isFinite(node.value)) return;
            if (isConstDeclaration(node)) return;
            if (isDefaultParam(node)) return;
            if (isEnumOrType(node)) return;

            // Skip array index patterns: arr[N]
            if (node.parent && node.parent.type === 'MemberExpression' && node.parent.computed && node.parent.property === node) return;

            context.report({
              node,
              messageId: 'magicNumber',
              data: { value: String(node.value) },
            });
          },
        };
      },
    },

    // ─── H-17: 散落工具函数检测（黄金原则 G-1） ─────────────────────────────────
    'no-duplicate-helper': {
      meta: {
        type: 'suggestion',
        docs: {
          description: '工具函数应集中在 shared/ 目录，禁止在模块内散落 util/helper 文件',
        },
        messages: {
          helperOutsideShared:
            '文件名「{{ filename }}」匹配工具函数模式（util/helper/common），但不在 shared/ 目录下。' +
            '请将公共工具函数提取到 shared/ 目录，避免跨模块重复。' +
            '参考 docs/harness/GOLDEN_RULES.md §G-1。',
        },
        schema: [{
          type: 'object',
          properties: {
            sharedDirs: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        }],
      },
      create(context) {
        const options = context.options[0] || {};
        const sharedDirs = options.sharedDirs || ['shared', 'common', 'lib'];
        const HELPER_NAME = /(?:^|[/\\])(?:utils?|helpers?|common)\.[mc]?[jt]sx?$/i;

        const filename = context.filename || context.getFilename();

        // Only trigger for files matching helper patterns
        if (!HELPER_NAME.test(filename)) return {};

        // Check if file is inside a shared directory
        const inShared = sharedDirs.some(dir => {
          const sep = /[/\\]/;
          return filename.split(sep).includes(dir);
        });

        if (inShared) return {};

        return {
          Program(node) {
            const basename = filename.split(/[/\\]/).pop();
            context.report({
              node,
              messageId: 'helperOutsideShared',
              data: { filename: basename },
            });
          },
        };
      },
    },
    // ─── CICD-01: 禁止直接调用 VCS CLI（CICD.md）─────────────────────────
    // 必须通过 scripts/pr-adapter.mjs 统一接口创建/合并 PR/MR。
    'no-direct-vcs-cli': {
      meta: {
        type: 'problem',
        docs: { description: '禁止源码中直接调用 gh pr / glab mr，统一走 pr-adapter.mjs' },
        messages: {
          directCli:
            '检测到直接调用 {{ tool }} 操作 PR/MR：「{{ snippet }}」。' +
            '请改为 `scripts/pr-adapter.mjs create|status|merge|comment`，以兼容 GitHub 与 GitLab。' +
            '参考 docs/harness/CICD.md。',
        },
        schema: [],
      },
      create(context) {
        // 允许 pr-adapter.mjs 自身使用 gh/glab
        const filename = context.filename || context.getFilename();
        if (/pr-adapter\.mjs$/.test(filename)) return {};

        const PATTERNS = [
          { tool: 'gh',   re: /\bgh\s+pr\s+(create|merge|comment|view|checks|review|edit|close|reopen|ready)\b/ },
          { tool: 'glab', re: /\bglab\s+mr\s+(create|merge|note|view|update|approve|close|reopen)\b/ },
        ];

        function check(node, value) {
          if (typeof value !== 'string') return;
          for (const { tool, re } of PATTERNS) {
            const m = value.match(re);
            if (m) {
              context.report({
                node,
                messageId: 'directCli',
                data: { tool, snippet: m[0].slice(0, 80) },
              });
              return;
            }
          }
        }

        return {
          Literal(node) { check(node, node.value); },
          TemplateLiteral(node) {
            for (const q of node.quasis) check(node, q.value.raw);
          },
          // 数组形式：spawn(['gh', 'pr', 'create', ...]) / execFile('glab', ['mr', ...])
          ArrayExpression(node) {
            const head = node.elements?.[0];
            const second = node.elements?.[1];
            if (!head || head.type !== 'Literal') return;
            const tool = head.value;
            if (tool !== 'gh' && tool !== 'glab') return;
            if (!second || second.type !== 'Literal') return;
            const sub = second.value;
            if (tool === 'gh' && sub === 'pr') {
              context.report({ node, messageId: 'directCli', data: { tool, snippet: `[${tool}, ${sub}, ...]` } });
            } else if (tool === 'glab' && sub === 'mr') {
              context.report({ node, messageId: 'directCli', data: { tool, snippet: `[${tool}, ${sub}, ...]` } });
            }
          },
          // execFile / spawn 第一参数为 'gh'/'glab'，第二参数数组首元素为 pr/mr
          CallExpression(node) {
            const callee = node.callee;
            const name = callee?.name || callee?.property?.name;
            if (!/^(spawn|spawnSync|execFile|execFileSync)$/.test(name || '')) return;
            const a0 = node.arguments?.[0];
            const a1 = node.arguments?.[1];
            if (!a0 || a0.type !== 'Literal') return;
            const tool = a0.value;
            if (tool !== 'gh' && tool !== 'glab') return;
            if (!a1 || a1.type !== 'ArrayExpression') return;
            const sub = a1.elements?.[0];
            if (!sub || sub.type !== 'Literal') return;
            if ((tool === 'gh' && sub.value === 'pr') || (tool === 'glab' && sub.value === 'mr')) {
              context.report({ node, messageId: 'directCli', data: { tool, snippet: `${name}(${tool}, [${sub.value}, ...])` } });
            }
          },
        };
      },
    },
  },
};
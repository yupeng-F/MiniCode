# Migration 规范

> 数据库与配置变更脚本的强制约束。专用于 `migration-design` 任务类型，由 deploy-sprint 的 `release-prep` 任务消费。
> 流程入口见 `docs/SPRINT.md`，任务规则见 `lint/task-rules.yml`。

---

## 目录与命名

```
templates/migration/                # 框架模板（项目从此处复制）
  ├── up.sql.tpl
  ├── down.sql.tpl
  └── README.md

deploy/release/<vX.Y.Z>/migrations/ # release-prep 产出物
  ├── 001-<slug>.up.sql
  ├── 001-<slug>.down.sql
  └── manifest.yml
```

**命名正则**：`^\d{3}-[a-z0-9-]+\.(up|down)\.sql$`

---

## manifest.yml Schema

```yaml
version: 1
release: vX.Y.Z
created_at: <ISO8601>
created_by: <agent-or-user>
items:
  - id: 001-<slug>
    description: 一句话说明此次变更的业务动机
    forward: 001-<slug>.up.sql
    rollback: 001-<slug>.down.sql
    requires: []                    # 可选：依赖的 migration id 列表
    reversible: true                # 不可逆（如 DROP COLUMN）需声明 false 并附预案
    forward_compatible: true        # 旧版本应用读新 schema 是否仍可工作
    estimated_duration_seconds: 30
signature: <git-commit-sha>          # 由 migration-check.mjs sign 写入
```

---

## 强制约束（脚本校验）

| 约束 | 校验脚本子命令 | 触发位置 |
|------|---------------|---------|
| 每个 `up` 必有同名 `down` | `migration-check.mjs pair` | quality.yml + release.yml |
| 命名匹配正则 | `migration-check.mjs name` | 同上 |
| `down` 在 dry-run 时无 syntax error | `migration-check.mjs dry-down` | release.yml D7 |
| Forward + rollback 演练通过 | `migration-check.mjs rehearse --env test` | release.yml D7 |
| Manifest signature 匹配当前 commit | `migration-check.mjs sign` | release.yml D9 |

---

## 编写规则（正向定义）

1. **可逆**：`up.sql` 必有对应 `down.sql`；不可逆变更须 `manifest.yml.reversible=false` 并在 PR 描述中附**人工回滚预案**。
2. **向前兼容**：旧版本应用读新 schema 应正常工作；破坏性变更采用双写窗口策略（先加列与双写 → 等到全量切换 → 再清旧列）。
3. **幂等**：脚本支持重复执行（`IF NOT EXISTS` / `IF EXISTS` 守卫）。
4. **幂等检查**：执行 `migration-check.mjs idempotency` 在 test 环境对脱敏快照执行 forward 两次，断言第二次无副作用。
5. **大表变更**：单批 ≤ 100k 行，分批使用 `LIMIT/OFFSET` 或主键范围。
6. **审计**：执行日志输出到 `deploy/release/<vX.Y.Z>/migration-log.txt`，含执行时间、行数、错误详情。

---

## 失败策略

| 阶段 | 动作 |
|------|------|
| Forward 失败 | 自动调用对应 `down.sql` 回滚；deploy.mjs 中止部署 |
| Rollback 也失败 | `migration-check.mjs lockdown` 锁数据库写入 + 触发 critical 告警 + ask_user |
| 演练失败（test） | release CD D7 FAIL，回到 plan 重新生成 |

---

## AI 执行协议（`migration-design` 任务）

**允许工具**：bash（`migration-check.mjs`）、文件读写、SQL 客户端 dry-run。
**禁止**：在 dev / prod 环境直接执行 forward。

**步骤**：
1. 加载技术方案（数据模型变更）+ 上一 release manifest（依赖关系）。
2. 生成 `up.sql` + `down.sql` + manifest 条目。
3. 执行 `migration-check.mjs pair name dry-down idempotency`。
4. 提交至 `deploy/release/<vX.Y.Z>/migrations/`。

**验收**：以上 4 项校验子命令退出码全为 0。

# 发布规范（v1.6 兼容说明）

> v1.6 起不再存在独立 `release` 任务，也不再使用 `harness-release` Agent。
> 发布被拆成 deploy-sprint 中的结构化任务，并由主 Agent 按 `docs/SPRINT.md`
> 和 `lint/task-rules.yml` 编排。

## 当前发布任务链

生产发布使用以下任务类型：

1. `release-prep`：生成 release notes、迁移清单、质量摘要
2. `migration-design`：设计并校验数据库迁移
3. `regression`：执行 L3 回归、性能与安全检查
4. `release-approval`：L3 上线许可，必须 `ask_user` 明确确认
5. `prod-deploy`：生产部署、健康窗口、自动回滚
6. `back-merge`：main → test/develop 回灌
7. `observe`：线上观测报告

发布资产统一写入 `deploy/release/<vX.Y.Z>/`；旧顶层 `release/` 目录由安装脚本迁移到 `.harness/migrations/`，避免继续作为新产出目录。

## 单一真源

| 内容 | 真源 |
|---|---|
| 发布任务流 | `docs/SPRINT.md` |
| 任务类型、门控、产出物、验收条件 | `lint/task-rules.yml` |
| CI/CD 红线、分支/环境策略、故障速查 | `docs/CICD.md` |
| 部署环境与 secret 声明 | `config/deploy.yml` |

如果历史 Sprint 计划仍包含 `release` 任务，应迁移为上述任务链。

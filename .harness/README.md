# Harness 中间过程数据目录

> Harness 框架任务执行过程产生的所有中间数据/产物落地目录。
> 由脚本管理；人手修改前先 `node scripts/lock.mjs check`。

## 子目录

| 目录 | 写入者 | 说明 |
|------|--------|------|
| `secrets/` | 人工填写 + `promote-prep.mjs` 首次生成模板 | `test.sh` / `prod.sh` 等本地运行时密钥；默认不入库 |
| `state/` | `lock.mjs` / `promote.mjs` / `acceptance-record.mjs` | 环境锁、提升日志、走查审批记录、版本戳 |
| `images/` | `build-image.mjs` / `build-artifact.mjs` | 本地镜像 tar / 构建产物（默认不入库） |
| `reports/` | `quality-score.mjs` / `verify.mjs` | 任务级临时报告（不入库） |

## 历史迁移

旧版本框架使用 `state/` 顶层目录。`install.sh` / `install.ps1` 安装时会自动：
- 迁移 `state/*` → `.harness/state/*`
- 删除空 `state/`；旧 `release/` 若非空则迁移到 `.harness/migrations/release-legacy-*`

## 版本戳

`.harness/state/harness-version.txt` 记录最近一次 `install` 同步的框架 SHA + 时间，便于追溯。

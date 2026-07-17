# CI/CD 设计规范

> **入门 / 流程 / 编排** 见 `docs/SPRINT.md` § CI/CD 与发布编排
> **脚本用法** 见 `scripts/<name>.mjs --help`
> **分支保护** 见 `.gitlab/protected-branches.yml`（GitLab 权威）+ `.github/branch-protection.json`（仓级硬约束）
> **环境矩阵** 见 `config/deploy.yml`（v1.6 起合并 environments + build-targets）
>
> 本文聚焦无法代码化的"为什么"——红线、不变性证据、关键策略与故障速查。

---

## 设计红线（why-only；how 在代码）

| # | 红线 | 强制点 |
|---|------|--------|
| **R1 Build Once, Deploy Many** | 生产部署用 test 验证过的同一份镜像产物，仅 retag promote；不变性证据按交付模式分别锚定 | `scripts/image-promote.mjs`（见 R1 矩阵） |
| **R2 分支 ↔ 环境一一映射** | `develop` ↔ dev；`test` ↔ test；`main` ↔ prod | `scripts/branch-env-check.mjs` |
| **R3 质量评分分层不重复** | L1 sprint·L2 promote·L3 release，维度互不重叠 | `scripts/quality-score.mjs --level L1\|L2\|L3` |
| **R4 Mock 仅出现在 dev** | mock 服务标 `profiles: ["dev"]`；test/prod 启动后 mock 容器 = 0 | `scripts/verify.mjs profile-check` |
| **R5 main 接受范围 = release \| hotfix** | 分支保护强制（**GitLab 权威**） | `.gitlab/protected-branches.yml` |
| **R6 PR/MR 走适配器** | Agent 不直接调 `gh`/`glab` | ESLint `harness/no-direct-vcs-cli` + `scripts/pr-adapter.mjs` |
| **R7 L3 双门禁** | `product-acceptance`（功能）+ `release-approval`（上线）独立记录 | `lint/task-rules.yml` 两条 gate=L3 |
| **R8 环境锁单写** | test 环境同一时刻仅 1 个 owner（promote 或 release） | `scripts/lock.mjs` |
| **R9 Test 走查双到达** | `walkthrough_env=test` 的 feature-sprint 关闭前，Boss signoff commit 必须同时抵达 `develop` 与 `test` | `sprint-gate.mjs sprint-close` 读取 `boss-signoff.yml` 的 `commit_sha` 并校验 `git merge-base --is-ancestor` |

### R1 不变性证据矩阵

| 交付模式（`HARNESS_DELIVERY_MODE`） | 不变性锚点 | 强制脚本 |
|---|---|---|
| `registry` | 1) image config SHA 跨 dev→test→prod 一致；2) `prod-*` tag 由 `docker buildx imagetools create` 写入 OCI label | `scripts/image-promote.mjs` registry 分支 |
| `artifact` | 1) tar 文件 sha256 跨环境一致；2) tar 内 image manifest digest 与 build 时一致；3) `prod-*` tag 由本地 `docker tag` 派生（**无 buildx imagetools** —— artifact 无远端 registry 可写 OCI label） | `scripts/image-promote.mjs` artifact 分支 + promotion-log 双字段 |

> **诚实声明**：artifact 模式 OCI label 不写远端 registry，等价证据由 promotion-log 双字段 + tar sha256 提供。两者 audit 强度等价：能回答"生产跑的 image 是不是 test 上验证过的那一份"。

---

## 三层测试矩阵

| 层 | 触发点 | 范围 | 强制脚本 |
|----|--------|------|----------|
| **L1 单元 + smoke E2E + P0 回归** | feature-sprint `quality` | 本 sprint 新增/修改 case；历史 P0 case；UI 还原度 + 主流程 smoke | `quality-score.mjs --level L1` |
| **L2 集成 + 跨服务 E2E** | deploy-sprint(test) 的 `integration` | 全量集成、Mock-free | `quality-score.mjs --level L2` |
| **L3 回归 + 性能 + 安全** | deploy-sprint(prod) 的 `regression` | 全 sprint 聚合，critical regression | `quality-score.mjs --level L3` + `release.mjs regression` |

---

## 关键策略（仅"为什么"）

### 交付模式默认值

Phase 1（Docker Compose + ssh）默认 `HARNESS_DELIVERY_MODE=artifact`：构建产物以 `.tar` 流转，`scp + docker load` 部署，无需 registry。registry 模式保留给 Phase 2（K8s）。

**registry 模式当前无 CI 覆盖**；使用前请手工 dry-run：`HARNESS_DELIVERY_MODE=registry node scripts/deploy.mjs --dry-run --env <env>`

### 镜像 Tag 命名

`dev-<sha>` →（promote）`test-<sha>` →（release）`prod-<vX.Y.Z>-<sha>`；hotfix 唯一例外：`prod-hotfix-<issue>-<sha>` 允许 `image-promote --force-rebuild`。

### Release ↔ Test 分支生命周期

| 阶段 | release/* | test |
|------|-----------|------|
| 切出 | `release.mjs init` 从 **test** HEAD 切出 `release/<vX.Y.Z>` | 持续接收 promote MR |
| L3 期间 | 占用 `.harness/state/test.lock`（TTL 14400s）；冻结 promote 入口 | 不再接受新 promote |
| 合并 | release MR `→ main`；**镜像不重建**，retag `test-<sha>` 为 `prod-<vX.Y.Z>-<sha>` | — |
| 合并后 | 分支保留作审计 | `back-merge.yml` 自动接收 main 回流 |

**Test 不是发布候选分支**——它是"集成验证池"。Release 才是发布候选。

### Hotfix

- `hotfix.yml` 拆 5 阶段（init/quality/image/pr/back-merge），不直部署。
- 合并 main 后人工 dispatch `production.yml`（紧急但保留 confirm 闸）。
- back-merge main → test → develop 由 production.yml 自动触发。

### 锁

- `.harness/state/<env>.lock` JSON；TTL 默认 7200s（release regression 14400s）。
- workflow 不直接读文件，调 `scripts/lock.mjs owner <env>`。
- 持锁责任：`promote.mjs` / `release.mjs` 内部 try/finally；workflow 仅在失败兜底。

### Secrets

- 声明：框架基础设施 secret 由 `scripts/lib/required-secrets.mjs` 内置；项目只在 `config/deploy.yml` 的 `extra_required_secrets[]` 追加。
- 运行时真源：`.harness/secrets/<env>.sh`；`promote-prep.mjs <env>` 缺失时自动生成模板，`env-check` / `deploy.mjs` 直接按 `source` 语义读取。
- 业务运行时变量默认来自项目本地 env 文件（默认 `src/.env`，或 `verify.config.sh::ENV_FILE`），不塞进 `.harness/secrets/<env>.sh`。
- 一致性：`scripts/secrets-sync-check.mjs` 在 quality.yml L1 强制校验 `secrets_source` 与本地 shell 文件约定是否一致；部署前再跑 runtime preflight。
- 字面值扫描：`scripts/secrets-scan.mjs`。

### 自动回滚

- `deploy.mjs watch --env prod --window 30m` 周期 health 检测 → 失败触发 `deploy.mjs rollback`。
- rollback 从 `.harness/state/promotion-log.yml` 取上一稳定 tag 重新部署。

---

## GitLab / GitHub 关系

- GitLab 是**权威 CI**（自动 + 手动）；merge 走 GitLab MR。
- GitHub 仅作镜像通道，`.github/branch-protection.json` 只保留仓级硬约束（review / no force-push / linear history / squash merge）。
- 历史 GitHub Actions 工作流归档于各项目 `.github/workflows.legacy/`，不再触发。
- **运维与 Agent 硬约束**：禁止用 GitHub UI 或 `gh pr merge` 合 PR 到 `main`；所有 main 合并必须走 GitLab MR（`main-source-gate` job 是 R5 在 GitLab 端的唯一权威校验）。
- 如果项目暂未接入 GitLab CI，仍必须走 GitLab MR 承载审批和分支保护；此时 MR 的 required checks 必须调整为项目真实可执行的检查，或由 Agent 在 MR 描述中附上本地全量检查证据并等待人工合并。禁止把“已临时部署到 test”当作“已通过 MR 到 test”。
- `walkthrough_env=test` 的 feature-sprint 有两条合并责任：功能交付 MR 到 `develop`，走查通过的同一 `commit_sha` MR 到 `test`。`sprint-close` 只认可 Git 分支到达，不认可手工部署痕迹。

---

## 故障速查

| 现象 | 第一动作 |
|------|----------|
| test 环境锁卡住 | `node scripts/lock.mjs check test` → `force-release test`（人工） |
| promotion 链断裂（label 缺失） | `docker buildx imagetools inspect <tag>` |
| sprint 未抵 test 但 release init 过 | 检查 `boss-signoff.yml` 的 `commit_sha` 字段 |
| back-merge 冲突 | production.yml 已 `continue-on-error`；查 `back-merge/*` 分支人工合 |
| prod 部署失败 | `deploy.mjs rollback --env prod`（自动）；查 `.harness/state/promotion-log.yml` |

# Secrets 与配置管理规范

> 部署密钥唯一真源：`.harness/secrets/<env>.sh`。不再依赖 GitHub/GitLab CI secret store。

---

## 端到端加载链路

```text
声明     config/deploy.yml::environments.<env>.{extra_required_secrets, secrets_source}
         框架基础设施 secret 由 scripts/lib/required-secrets.mjs 内置
  ↓
模板     node scripts/promote-prep.mjs <env>
         若 .harness/secrets/<env>.sh 不存在，则自动生成占位模板
  ↓
填写     人工编辑 .harness/secrets/<env>.sh
         使用 export NAME=...；多行私钥也允许直接写在 shell 文件里
  ↓
校验     node scripts/env-check.mjs validate --mode runtime --env <env>
         node scripts/deploy.mjs preflight-secrets --env <env>
  ↓
运行     deploy.mjs / release.mjs / promote-prep.mjs 直接 source 该文件并读取值
```

## 第一次部署前必做

1. 运行 `node scripts/promote-prep.mjs <env>`。
2. 若提示已生成 `.harness/secrets/<env>.sh`，打开文件填写真实值。
3. 重跑 `promote-prep` 或 `deploy.mjs preflight-secrets --env <env>`，直到缺失项为 0。

**测试环境的 IP / SSH key 填哪？** 一律填在 `.harness/secrets/<env>.sh`：
- `<ENV>_DEPLOY_HOST` / `<ENV>_DEPLOY_USER` / `<ENV>_DEPLOY_PORT` / `<ENV>_DEPLOY_WORKDIR`
- `<ENV>_SSH_PRIVATE_KEY`

**业务运行时配置填哪？** 继续放项目本地 env 文件（默认 `src/.env`，或 `verify.config.sh` 里的 `ENV_FILE`）：
- `DATABASE_URL` / `REDIS_URL` / `JWT_SECRET`
- `MINIO_*`
- `PASSWORD_LOGIN_*`
- `WECOM_*`
- `AI_*`

---

## `secrets_source` 约束

| 环境 | 固定取值 |
|------|---------|
| test | `.harness/secrets/test.sh` |
| prod | `.harness/secrets/prod.sh` |

`env-check.mjs validate` 与 `secrets-sync-check.mjs` 会强制校验该字段，避免项目继续保留旧 CI secrets 心智。

---

## 强制规则（脚本校验）

| 规则 | 校验脚本 | 触发位置 |
|------|---------|---------|
| 仓库内不出现 secret 字面值 | `secrets-scan.mjs scan` | pre-commit + quality |
| 跨环境 secret 名称不复用 | `secrets-scan.mjs check-cross-env` | quality |
| `deploy.yml` 仅声明 deploy 拓扑与 deploy 级 secret 名字（无值） | `env-check.mjs validate --mode schema` | quality |
| `secrets_source` 必须指向 `.harness/secrets/<env>.sh` | `secrets-sync-check.mjs` | quality |
| 部署前完整性检查 | `env-check.mjs validate --mode runtime --env <env>` + `deploy.mjs preflight-secrets --env <env>` | deploy-sprint / release / hotfix |

---

## 失败策略

| 场景 | 动作 |
|------|------|
| `promote-prep` 发现文件缺失 | 自动生成 `.harness/secrets/<env>.sh` 模板并失败退出 |
| shell 文件语法错误 / 无法加载 | `promote-prep` / `deploy.mjs` 明确报错并阻断 |
| 部署前完整性检查 missing | `deploy.mjs preflight-secrets` 退出非 0；修复 shell 文件后重跑 |
| CI / 代码扫描命中字面值 | quality FAIL，阻断合并 |

---

## AI 执行协议

任何 Agent 在生成代码或文档时：
1. 不得直接写入真实 secret 值。
2. 新增业务运行时变量优先放项目本地 env 文件；只有新增 deploy 期 env 前缀变量时才更新 `config/deploy.yml` 的 `extra_required_secrets`。
3. 若部署缺失密钥，优先生成/提示补全 `.harness/secrets/<env>.sh`，而不是引导去配置 CI secrets。

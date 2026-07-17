# Release vX.Y.Z

> 由 `scripts/release.mjs init` 自动生成；release-prep 任务在此基础上补全章节。

- **发布时间**：<YYYY-MM-DD>
- **发布范围**：<纳入本次发布的 sprint id 列表>
- **责任人**：<release manager>
- **变更类型**：feat | fix | refactor | chore（多选）

## 1. 业务亮点

<面向最终用户的一句话价值描述。>

## 2. 纳入 Sprint

| Sprint | 标题 | 关联 User Story | 负责人 |
|--------|------|----------------|--------|
| sprint-N | … | US-… | … |

## 3. 数据迁移

- 涉及 migration：见 `deploy/release/vX.Y.Z/migrations/manifest.yml`
- 不可逆变更：<列出或填"无"> 
- 双写窗口：<列出或填"无"> 

## 4. 配置变更

| 配置项 | 旧值 | 新值 | 影响 |
|--------|------|------|------|
| … | … | … | … |

## 5. 部署步骤

参见 `deploy/release/vX.Y.Z/deploy/`：
- 镜像 tag：`prod-vX.Y.Z-<sha>`（promote 自 `test-<sha>`）
- compose override：`deploy/prod-overrides.yml`
- 健康窗口：30 min（环境 yml 配置）

## 6. 回滚预案

- 自动回滚触发：error_rate > 1% / p95 > 500ms / cpu > 85%
- 手动命令：`node scripts/deploy.mjs rollback --env prod`
- 数据回滚：见 manifest 中各 item 的 rollback 文件

## 7. 风险与缓解

| 风险 | 影响范围 | 缓解 |
|------|---------|------|
| … | … | … |

## 8. 待办

- [ ] L3 release-approval 走查
- [ ] 健康窗口完成确认
- [ ] observe 任务完成

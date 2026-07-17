# Observability

> 线上观测与验证规范。`release` / `prod-deploy` 部署成功后执行。
> 日志/错误处理规范见 [CODING_BACKEND.md](CODING_BACKEND.md)，部署架构见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。
>
> **可执行查询模板**：[`templates/observability/`](../templates/observability/)
> 含 PromQL（`error-rate` / `p95-latency` / `slo-burn` / `saturation`）与 LogQL
> （`errors-by-service` / `trace` / `no-secret-leak`）。本文件不再重复展开模板内容。
>
> **校验入口**：`node scripts/observability-check.mjs validate`

**产出物**：`docs/observability-reports/sprint-N-observe.md`（须更新 `index.md`）

---

## 观测维度体系

### 维度一：健康检查（6 项）

| # | 检查项 | 期望结果 |
|---|--------|----------|
| 1 | API `GET /health` | HTTP 200 |
| 2 | API `GET /ready`（含 database + redis） | HTTP 200，`status: "ok"` |
| 3 | 前端页面可访问 | HTTP 200 |
| 4 | SSL 证书有效 | ssl_verify_result = 0 |
| 5 | DNS 解析正确 | 解析到预期 IP / CNAME |
| 6 | 响应时间 | < 500ms |

### 维度二：日志验证（6 项）

| # | 检查项 | 期望结果 |
|---|--------|----------|
| 1 | 日志输出到部署平台日志系统 | 有新日志产生 |
| 2 | JSON 结构化格式 | 含 `level` / `time` / `msg` |
| 3 | 每条日志包含 requestId | `requestId` 非空 |
| 4 | 无敏感信息泄露 | 不含 API Key、Token、密码明文 |
| 5 | 无 stack trace 泄露到响应 | 错误响应仅含 `code` + `message` + `requestId` |
| 6 | 生产日志级别 ≥ INFO | `level` 不低于 INFO |

### 维度三：监控指标（6 项）

| # | 指标 | 基线 |
|---|------|------|
| 1 | API P50 延迟 | < 200ms |
| 2 | API P99 延迟 | < 1000ms |
| 3 | 错误率（5xx） | < 1% |
| 4 | 资源利用率 | CPU / Memory < 80% |
| 5 | 数据库连接池 | 活跃连接 < 池上限 80% |
| 6 | Redis 连接 | 正常，延迟 < 5ms |

### 维度四：告警基线（5 项）

| # | 告警规则 | 触发条件 |
|---|----------|----------|
| 1 | 错误率告警 | 5xx 率 > 5%（5min 窗口） |
| 2 | 延迟告警 | P99 > 基线 2x |
| 3 | 服务不可用 | 健康检查连续失败 ≥ 2 次 |
| 4 | 告警通道可达 | 通知渠道已验证 |
| 5 | 无未确认告警 | 近 1h 无 open incident |

### 维度五：部署验证（6 项）

| # | 检查项 | 期望结果 |
|---|--------|----------|
| 1 | 版本与预期一致 | 匹配 release tag |
| 2 | 环境变量配置正确 | 关键配置项已设置 |
| 3 | 依赖服务连通 | ARCHITECTURE.md 中定义的依赖均可达 |
| 4 | 实例数在预期范围 | min ≤ N ≤ max |
| 5 | 无 crash loop | 30min 内无非正常重启 |
| 6 | 流量指向最新版本 | 100% 切至最新 |

---

## 通过标准与严重级别

**通过**：5 个维度全部检查项达标。

| 级别 | 定义 | 处理 |
|------|------|------|
| Critical | 服务不可用、健康检查失败、依赖断连 | 立即回滚 |
| Major | 性能超基线 2x、日志无 requestId、告警未配置 | 当前迭代修复 |
| Minor | 性能接近上限、日志部分不规范 | 记录 `tech-debt-tracker.md` |

---

## 用例生成指引

> AI 不使用预置命令，须从检查项 + 上游产出物动态生成观测用例。

**输入**：ARCHITECTURE.md（部署拓扑/日志系统/监控系统）+ 技术方案（API 列表/性能基线）+ Release 产出（版本号/URL）

**每个检查项生成 ≥ 1 个可执行命令**，用例格式：`OBS-维度-序号` | 执行命令 | 期望结果 | 实际结果 | 判定

---

## 完成标准（DoD）

- 5 维观测框架全部检查项已执行
- 观测报告已生成并保存至 `docs/observability-reports/`
- 健康检查 6/6 通过、日志正常、核心指标在基线内、告警已配置、部署版本正确

---

## AI 执行协议

**允许工具**：bash（curl/日志查询/监控 API）、文件读取 | **禁止**：代码修改

**执行步骤**：
1. 确认部署完成（版本号、环境 URL）
2. 生成观测用例（按上述指引）
3. 执行 `node scripts/verify.mjs health logs metrics`
4. 补充平台特定验证（告警配置、依赖连通等）
5. 生成观测报告，判定通过/不通过

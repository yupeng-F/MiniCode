#!/usr/bin/env bash
# ⚠️ MAI-Harness 框架文件 — 请勿在项目中修改。如需变更请在框架工程中修改并覆盖到此项目。
# =============================================================================
# Harness Verify — 项目验证配置模板
#
# 复制到项目根目录，按实际情况填写。留空的项会被 verify.sh 跳过。
# =============================================================================

# ─── 端点 ────────────────────────────────────────────────────────────────────
API_URL="http://localhost:3000"
WEB_URL="http://localhost:5173"
HEALTH_ENDPOINT="/health"
READY_ENDPOINT="/ready"

# ─── 本地 Docker 统一运行（G-8）─────────────────────────────────────────────
# 本地联调 / API 测试 / E2E / 冒烟 / UI 还原度 / 产品走查统一基于 Docker 容器运行。
# `node scripts/verify.mjs docker-up` 先回收同名容器 + 端口，再按当前代码重建镜像并启动。
DOCKER_COMPOSE_FILE="docker-compose.yml"
DOCKER_BUILD_SERVICES="api web"     # 空格分隔，按源码重建的服务（中间件通常无需重建）

# ─── 启动 ────────────────────────────────────────────────────────────────────
STARTUP_CMD="docker compose up -d"
STARTUP_WAIT=20                   # 启动等待秒数（容器 healthy）

# ─── 截图验证（空格分隔页面路径）────────────────────────────────────────────
SCREENSHOT_PATHS="/ /login"

# ─── 日志查询（可插拔，留空则跳过）───────────────────────────────────────────
# 示例（Docker）:  LOG_QUERY_CMD="docker logs app --tail 50 --since 5m"
# 示例（LogQL）:   LOG_QUERY_CMD="logcli query '{app=\"myapp\"}' --limit=20"
# 示例（本地文件）: LOG_QUERY_CMD="tail -50 /var/log/app/app.log"
LOG_QUERY_CMD=""
LOG_VALIDATE_FIELDS="level time msg"   # 期望的日志字段

# ─── 指标查询（可插拔，留空则跳过）───────────────────────────────────────────
# 示例（PromQL）: METRIC_QUERY_CMD="curl -s 'http://prometheus:9090/api/v1/query?query=up{app=\"myapp\"}'"
# 示例（本地）:   METRIC_QUERY_CMD="curl -s http://localhost:3000/metrics"
METRIC_QUERY_CMD=""

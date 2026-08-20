# 记忆、上下文与模型产品化实施计划

> **给执行本计划的 Agent：** 必须使用 `superpowers:executing-plans` 逐项实施；每个行为变更必须使用 `superpowers:test-driven-development`；报告完成前必须使用 `superpowers:verification-before-completion`。

**目标：** 为 MiniCode 增加可验证的上下文硬预算、Run 级模型固定与会话级模型切换，以及按项目隔离的长中短记忆和关键词/向量混合检索。

**架构：** 保持 `QueryLoop -> ContextManager -> ModelClient` 主链不变，在上下文构建前增加统一 Token 计量和分区预算；用 `ModelCatalog` 统一后端允许模型与前端能力发现；用 SQLite FTS5 保存可解释的记忆索引、Chroma 保存分模型向量，`MemoryService` 负责分层治理和 RRF 融合。远程 embedding 优先、本地模型显式安装后兜底、两者都不可用时退化到 FTS5，不阻塞普通 Run。

**技术栈：** Python 3.11+、FastAPI、Pydantic、SQLite/FTS5、ChromaDB、tiktoken、FastEmbed（可选）、React 18、TypeScript、Vitest。

**设计来源：** `docs/01_项目目标与架构设计.md`

## 全局约束

- 每个行为先写失败测试，再写最小实现，再运行相关回归测试。
- 新增或更新的设计文档、实施计划、代码注释和用户可见提示默认使用中文；类名、API 字段、命令及第三方模型标识保留原始英文。
- 不把 API Key、业务空间 ID 或用户真实路径写入版本库；只提交变量名和示例值。
- 所有记忆默认项目隔离；只有显式声明为全局的用户偏好可以跨项目。
- 单条用户输入超过 12,000 tokens 时返回 HTTP 422，不静默截断。
- 发给模型的完整输入预算上限 48,000 tokens，输出上限 8,000 tokens，安全预留 8,000 tokens。
- 一个 Run 创建后固定 `model_id`；只有 Run 进入终态后才能切换会话默认模型。
- embedding 失败不得让普通对话失败；必须记录实际使用的检索路径并向 UI 暴露。

---

## 里程碑 1：Token 计量和上下文硬预算

### 任务 1：实现保守 TokenCounter 和预算异常

**Files:**

- Create: `src/minicode/context/token_counter.py`
- Modify: `src/minicode/context/token_budget.py`
- Modify: `src/minicode/context/__init__.py`
- Create: `tests/test_token_budget.py`

**Step 1: 写失败测试**

覆盖以下行为：

```python
def test_counter_uses_larger_estimate_with_safety_multiplier():
    counter = TokenCounter(tokenizer=FakeTokenizer(100))
    assert counter.count("混合中文 and code") >= 110

def test_budget_rejects_oversized_user_message():
    with pytest.raises(UserMessageTooLarge):
        TokenBudget().validate_user_message(FakeCounter(12_001), "x")

def test_budget_exposes_named_partitions():
    assert sum(TokenBudget().partitions.values()) == 48_000
```

**Step 2: 运行测试确认失败**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_token_budget.py -q`

Expected: FAIL，模块或类尚不存在。

**Step 3: 写最小实现**

实现：

```python
class TokenCounter:
    def count(self, value: object) -> int:
        serialized = self._serialize(value)
        tokenizer_count = self._tokenizer_count(serialized)
        heuristic_count = self._mixed_language_estimate(serialized)
        return math.ceil(max(tokenizer_count, heuristic_count) * 1.10)

@dataclass(frozen=True)
class TokenBudget:
    max_input_tokens: int = 48_000
    max_output_tokens: int = 8_000
    safety_reserve_tokens: int = 8_000
    max_user_message_tokens: int = 12_000
```

命名分区固定为：system/tools 8k、current task 12k、recent messages 8k、tool history 10k、memory 4k、compact summary 3k、plan/files/meta 2k、margin 1k。

**Step 4: 运行测试确认通过**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_token_budget.py -q`

Expected: PASS。

**Step 5: 提交**

```bash
git add src/minicode/context tests/test_token_budget.py
git commit -m "feat: add conservative token budgets"
```

### 任务 2：构建结构化 ContextProjection 并执行分区裁剪

**Files:**

- Modify: `src/minicode/context/context_manager.py`
- Modify: `src/minicode/context/compact_manager.py`
- Modify: `src/minicode/engine/prompt_builder.py`
- Modify: `src/minicode/engine/query_loop.py`
- Modify: `src/minicode/engine/providers/deepseek.py`
- Modify: `src/minicode/schemas/session.py`
- Modify: `tests/test_memory_context.py`
- Modify: `tests/test_minicode_query_loop.py`
- Modify: `tests/test_deepseek_model.py`

**Step 1: 写失败测试**

测试 `ContextProjection` 包含每个分区的 token 数、总数和裁剪原因；验证最新用户任务只出现在 current task，不再复制到 recent messages；验证 native tool history、`reasoning_content` 和 JSON 序列化均计入总预算。

```python
projection = manager.build(state, task="read README")
assert projection.total_tokens <= 48_000
assert projection.current_task.count("read README") == 1
assert "read README" not in projection.recent_messages
assert projection.usage["memory"] <= 4_000
```

**Step 2: 运行相关测试确认失败**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_memory_context.py tests/test_minicode_query_loop.py tests/test_deepseek_model.py -q`

**Step 3: 写最小实现**

新增：

```python
@dataclass
class ContextProjection:
    system_and_tools: list[dict[str, object]]
    current_task: str
    recent_messages: list[dict[str, object]]
    tool_history: list[dict[str, object]]
    memory: str
    compact_summary: str
    plan_files_meta: str
    usage: dict[str, int]
    dropped: list[str]

    @property
    def total_tokens(self) -> int: ...
```

裁剪顺序为：旧工具全文转 artifact preview、旧消息 compact、中期记忆减少、最近消息减少；当前任务和系统安全约束不得静默裁剪。最终请求仍超限时抛出 `ContextBudgetExceeded`，不得调用模型。

**Step 4: 运行测试确认通过**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_memory_context.py tests/test_minicode_query_loop.py tests/test_deepseek_model.py -q`

**Step 5: 提交**

```bash
git add src/minicode/context src/minicode/engine src/minicode/schemas/session.py tests/test_memory_context.py tests/test_minicode_query_loop.py tests/test_deepseek_model.py
git commit -m "feat: enforce context projection budgets"
```

### 任务 3：Web API 输入硬限制和预算遥测

**Files:**

- Modify: `src/minicode/interfaces/web/server.py`
- Modify: `src/minicode/engine/events.py`
- Modify: `src/minicode/application/run_service.py`
- Modify: `tests/test_minicode_web.py`
- Modify: `tests/test_run_persistence.py`

**Step 1: 写失败测试**

验证 12,001-token 输入返回 422，边界值可创建 Run；验证 Run 事件/查询结果包含 `context_usage`，但不泄露 prompt 正文。

**Step 2: 运行测试确认失败**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_minicode_web.py tests/test_run_persistence.py -q`

**Step 3: 实现并接入统一校验**

在 API 入口和 QueryLoop 入口各保留一道相同校验，API 返回稳定错误结构：

```json
{"detail":{"code":"user_message_too_large","limit":12000,"actual":12001}}
```

将分区 token 用量、裁剪动作、模型输入总量记录到结构化事件。

**Step 4: 运行测试确认通过并提交**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_minicode_web.py tests/test_run_persistence.py -q`

Commit: `feat: validate request token limits`

---

## 里程碑 2：模型选择和输入交互

### 任务 4：增加 ModelCatalog、会话默认模型和 Run 固定模型

**Files:**

- Create: `src/minicode/engine/model_catalog.py`
- Modify: `src/minicode/engine/model_factory.py`
- Modify: `src/minicode/schemas/session.py`
- Modify: `src/minicode/storage/sqlite_store.py`
- Modify: `src/minicode/application/session_service.py`
- Modify: `src/minicode/application/run_service.py`
- Modify: `src/minicode/interfaces/web/server.py`
- Modify: `tests/test_deepseek_model.py`
- Modify: `tests/test_project_session_services.py`
- Modify: `tests/test_minicode_web.py`

**Step 1: 写失败测试**

测试默认值 `deepseek-v4-flash`、允许值 `deepseek-v4-pro`、未知模型 422、活动 Run 期间切换 409、终态后可切换、恢复审批时仍使用 Run 原模型。

**Step 2: 运行测试确认失败**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_deepseek_model.py tests/test_project_session_services.py tests/test_minicode_web.py -q`

**Step 3: 写最小实现**

```python
@dataclass(frozen=True)
class ModelProfile:
    id: str
    label: str
    provider: str
    context_window: int
    max_output_tokens: int

MODEL_CATALOG = {
    "deepseek-v4-flash": ModelProfile(...),
    "deepseek-v4-pro": ModelProfile(...),
}
```

SQLite 采用向后兼容迁移增加 `sessions.model_id` 和 `runs.model_id`。`POST /api/runs` 创建时把会话默认模型复制到 Run；`ModelFactory` 必须接收 Run 的 `model_id`，不在恢复时重新读取会话默认值。

新增 `GET /api/capabilities` 返回允许模型、默认模型、输入/输出预算和 embedding 能力。

**Step 4: 运行测试确认通过并提交**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_deepseek_model.py tests/test_project_session_services.py tests/test_minicode_web.py -q`

Commit: `feat: pin selectable models to runs`

### 任务 5：前端模型切换、Enter 发送和 token 提示

**Files:**

- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/src/api.test.ts`
- Modify: `web/src/App.test.ts`

**Step 1: 写失败测试**

覆盖：能力接口渲染 flash/pro；默认 flash；Run 进行中 select disabled；终态后可切换；Enter 发送；Shift+Enter 换行；IME composition 的 Enter 不发送；超过 12k tokens 显示警告并禁用发送。

**Step 2: 运行测试确认失败**

Run: `cd web && npm test -- --run`

**Step 3: 实现交互**

键盘逻辑：

```tsx
if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
  event.preventDefault()
  void submitMessage()
}
```

模型选择写回 session；Run 请求仍携带后端已固定的模型。显示近似 token 数和后端返回的实际预算状态。

**Step 4: 运行测试确认通过并提交**

Run: `cd web && npm test -- --run`

Commit: `feat: add model selector and enter-to-send`

---

## 里程碑 3：长中短记忆和混合检索

### 任务 6：定义记忆记录、检索结果和 SQLite FTS5 索引

**Files:**

- Create: `src/minicode/schemas/memory.py`
- Create: `src/minicode/memory/memory_index.py`
- Modify: `src/minicode/storage/sqlite_store.py`
- Modify: `src/minicode/memory/memory_service.py`
- Create: `tests/test_memory_index.py`
- Modify: `tests/test_memory_context.py`

**Step 1: 写失败测试**

验证项目隔离、global preference 白名单、中文二/三元切词、代码标识符和路径保留、FTS 排序、禁用/删除记忆不再命中。

```python
result = service.retrieve(task="Harness 工程底座", active_files=["docs/Harness工程底座培训.html"], mode="act")
assert result.items[0].project_id == project.id
assert result.items[0].keyword_score > 0
```

**Step 2: 运行测试确认失败**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_memory_index.py tests/test_memory_context.py -q`

**Step 3: 实现数据模型和索引**

`MemoryRecord` 至少包含：id、project_id、tier、kind、content、source、active_files、created_at、last_used_at、use_count、pinned、enabled、sensitive、embedding_state。`MemoryRetrievalResult` 包含 items、provider、fallback_reason、external_transfer、token_count。

FTS5 只保存用于检索的派生文本，Markdown 仍是长期记忆的 canonical source。同步写入使用同一服务事务，并提供幂等 `rebuild_project_index(project_id)`。

**Step 4: 运行测试确认通过并提交**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_memory_index.py tests/test_memory_context.py -q`

Commit: `feat: index tiered memory with fts5`

### 任务 7：EmbeddingProvider、阿里云适配器和本地显式安装

**Files:**

- Create: `src/minicode/memory/embedding.py`
- Create: `src/minicode/memory/embedding_config.py`
- Create: `src/minicode/memory/embedding_setup.py`
- Modify: `src/minicode/interfaces/cli.py`
- Modify: `pyproject.toml`
- Modify: `.env.example`
- Create: `tests/test_embedding_provider.py`

**Step 1: 写失败测试**

使用 fake HTTP client 验证业务空间 URL 构造、模型名 `qwen3.7-text-embedding`、1024 维校验、8 秒超时、敏感内容不外发、远程失败时切本地、无本地模型时切 FTS。验证普通 Run 不触发模型下载。

**Step 2: 运行测试确认失败**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_embedding_provider.py -q`

**Step 3: 实现适配器**

定义：

```python
class EmbeddingProvider(Protocol):
    @property
    def identity(self) -> EmbeddingIdentity: ...
    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]: ...
    def embed_query(self, text: str) -> list[float]: ...
```

远程 URL 优先由 `DASHSCOPE_WORKSPACE_ID` 和 `DASHSCOPE_REGION` 构造，可由 `DASHSCOPE_BASE_URL` 覆盖；未配置 workspace 时使用公共兼容地址。本地 provider 只加载已下载的 `BAAI/bge-small-zh-v1.5`，CLI `minicode embedding install-local` 才允许下载。

`pyproject.toml` 将 Chroma/tiktoken 放入正式依赖，FastEmbed 放入 `embedding-local` 可选依赖，避免基础安装强制下载模型。

**Step 4: 运行测试确认通过并提交**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_embedding_provider.py -q`

Commit: `feat: add remote and local embedding providers`

### 任务 8：Chroma 分集合向量索引和 RRF 混合排序

**Files:**

- Create: `src/minicode/memory/vector_store.py`
- Create: `src/minicode/memory/hybrid_retriever.py`
- Modify: `src/minicode/memory/memory_service.py`
- Create: `tests/test_hybrid_memory.py`

**Step 1: 写失败测试**

验证集合名包含 provider/model/dimension；不同维度不能混写；关键词和向量各取 top 30；RRF 权重为 vector 0.45、keyword 0.30、path 0.10、recency 0.10、usefulness 0.05；最终 top 8、总记忆 4k tokens、单项 1k tokens。

**Step 2: 运行测试确认失败**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_hybrid_memory.py -q`

**Step 3: 实现混合检索**

```python
score = (
    0.45 * reciprocal_rank(vector_rank)
    + 0.30 * reciprocal_rank(keyword_rank)
    + 0.10 * path_score
    + 0.10 * recency_score
    + 0.05 * usefulness_score
)
```

远程检索前台只尝试一次，8 秒后立即降级；后台索引任务最多 3 次指数退避。每次结果记录实际 provider 和 fallback reason。

**Step 4: 运行测试确认通过并提交**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_hybrid_memory.py tests/test_memory_context.py -q`

Commit: `feat: retrieve memory with hybrid ranking`

### 任务 9：中期 Run 摘要、长期 Markdown 治理和保留策略

**Files:**

- Modify: `src/minicode/memory/memory_service.py`
- Modify: `src/minicode/memory/markdown_memory.py`
- Modify: `src/minicode/application/run_service.py`
- Modify: `src/minicode/engine/query_loop.py`
- Modify: `tests/test_observability_memory_governance.py`
- Modify: `tests/test_run_persistence.py`

**Step 1: 写失败测试**

验证短期记忆只在当前 Run；成功/失败终态生成中期摘要；30 天或超过 200 条时按时间、相关度、使用频率淘汰；pinned 不淘汰；长期规则仍由 Markdown 驱动；自动捕获只生成候选，确认后才启用。

**Step 2: 运行测试确认失败**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_observability_memory_governance.py tests/test_run_persistence.py -q`

**Step 3: 实现生命周期钩子和治理**

Run 终态摘要包含任务、结果、重要文件、工具结论、失败原因和验证命令，不保存大段原始输出。每次写入后异步执行项目级 retention；现有 Markdown 条目可幂等重建到 FTS/Chroma。

**Step 4: 运行测试确认通过并提交**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_observability_memory_governance.py tests/test_run_persistence.py -q`

Commit: `feat: govern medium and long term memory`

---

## 里程碑 4：集成、可见性和真实浏览器验收

### 任务 10：把检索结果接入 ContextManager 和 Web 状态

**Files:**

- Modify: `src/minicode/context/context_manager.py`
- Modify: `src/minicode/interfaces/web/server.py`
- Modify: `src/minicode/engine/events.py`
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Modify: `tests/test_minicode_web.py`
- Modify: `web/src/App.test.ts`

**Step 1: 写失败测试**

验证 `task + active_files + mode` 实际传入检索；UI 显示“阿里云 embedding / 内容将外发”“本地 embedding”“关键词降级”三种状态；模型回答可引用命中的 README/HTML 内容；检索失败不阻塞回答。

**Step 2: 运行测试确认失败**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest tests/test_minicode_web.py tests/test_memory_context.py -q`

Run: `cd web && npm test -- --run`

**Step 3: 接入并显示状态**

ContextManager 只注入 `MemoryRetrievalResult.rendered_context`，同时把 provider、外发提示、fallback reason 和 token 使用写入事件。前端使用 capabilities 和 Run 事件显示，不猜测后端状态。

**Step 4: 运行测试确认通过并提交**

Commit: `feat: expose memory retrieval status`

### 任务 11：同步文档和配置示例

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/01_项目目标与架构设计.md`
- Modify: `.env.example`

**Step 1: 校验文档中的命令和变量名**

必须包含：唯一推荐启动命令、端口占用排查、DeepSeek chat 配置、阿里云 embedding 配置、本地 embedding 显式安装命令、flash/pro 切换规则、Enter/Shift+Enter、记忆降级说明。示例不得包含真实 Key 或真实 workspace ID。

**Step 2: 执行命令级 smoke test**

Run: `env PYTHONPATH=src conda run -n LLM python -m minicode.interfaces.web.server --help`

Run: `env PYTHONPATH=src conda run -n LLM python -m minicode.interfaces.cli --help`

**Step 3: 提交**

```bash
git add README.md AGENTS.md docs/01_项目目标与架构设计.md .env.example
git commit -m "docs: document memory and model configuration"
```

### 任务 12：完整自动化测试和 Chrome E2E

**Files:**

- Modify only if a verified defect is found in the files owned by prior tasks.

**Step 1: Python 全量测试**

Run: `env PYTHONPATH=src conda run -n LLM python -m pytest -q`

Expected: 全部 PASS，无 warning 被当作新回归。

**Step 2: 前端测试与构建**

Run: `cd web && npm test -- --run`

Run: `cd web && npm run build`

Expected: 全部 PASS，TypeScript 无错误。

**Step 3: 启动唯一后端实例**

先用 `lsof -nP -iTCP:8080 -sTCP:LISTEN` 确认端口；如果已有本项目服务，复用并确认代码版本；否则运行：

```bash
env PYTHONPATH=src conda run -n LLM python -m minicode.interfaces.web.server --host 127.0.0.1 --port 8080
```

**Step 4: 使用用户 Chrome 完成真实 E2E**

依次验证：

1. 新建项目和会话，默认模型为 flash。
2. 输入“当前项目的 readme 说明项目的目标是什么”，按 Enter，获得基于真实 README 的回答。
3. Shift+Enter 产生换行，中文输入法候选确认不误发送。
4. 在 Run 进行中模型选择禁用；结束后切换 pro，下一 Run 使用 pro。
5. 询问“`Harness工程底座培训.html` 这份资料主要讲了什么”，确认文件读取、工具事件和最终回答完整。
6. 执行一次受控文件写入并确认 diff/审批，再读取文件验证修改存在。
7. 检查 embedding 状态明确显示远程、本地或 FTS 降级路径。
8. 重启服务后确认项目、会话、Run 模型和记忆仍可恢复。

**Step 5: 最终差异和安全检查**

Run: `git status --short`

Run: `git diff --check`

Run: `git diff --stat`

确认 `.env` 未被跟踪：`git ls-files .env` 必须无输出。

**Step 6: 最终提交**

仅在 E2E 修复产生必要改动时提交：

```bash
git add <verified-files>
git commit -m "test: complete browser productization flow"
```

## 完成定义

- 所有 Python 和前端测试通过，前端构建成功。
- 12k 单消息和 48k 总输入硬限制在 API 与 QueryLoop 双层生效。
- flash/pro 可切换且 Run 内不可漂移。
- `MemoryService.retrieve()` 确实使用 task、active files 和 mode。
- 长中短记忆边界、项目隔离、保留策略和 Markdown canonical source 均有自动化测试。
- 远程 embedding、本地 embedding、FTS-only 三条路径均可观察、可测试、可降级。
- Chrome 中完成真实文件读写、审批、模型切换、问答和服务重启恢复测试。

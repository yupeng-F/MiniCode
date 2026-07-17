# MiniCode Productization Implementation Plan

> **Status (2026-07-17):** The migration from the legacy `multi_agents / LangGraph` prototype to the `minicode` architecture is complete. This document remains the productization roadmap; unchecked items such as controlled SubAgents, durable audit/evaluation, and restart-safe approval recovery are not part of the completed migration claim.

## Progress Snapshot

| Milestone | Status | Current result |
|---|---|---|
| 1. DeepSeek tool calling | Complete | Environment-based model factory, OpenAI-compatible tools, native assistant/tool history, CLI and daemon wiring, provider tests. |
| 2. Project/session/run lifecycle | Usable baseline | Persistent project/session index, independent run IDs, project/session deletion, polling, approval and resume. Restart-safe active runs, cancel, rename/archive and persisted events remain. |
| 3. Context/artifacts/memory | Usable baseline | Bounded recent tool output, paged reads, compaction, project-isolated Markdown rules, sensitive filtering and verified automatic captures. Candidate promotion, contradiction audit and management UI remain. |
| 4. Controlled SubAgent | Not started | `task_agent` and isolated explorer/reviewer runtimes remain planned. |
| 5. Three-pane web client | Usable baseline | React/Vite project and session navigation, file browser/viewer, tool timeline, approval controls and deletion. SSE-first state, full diff/plan/artifact views and responsive drawers remain. |
| 6. Observability/evaluation | Planned | Regression tests exist, but durable trace/audit/eval modules and release scenarios remain. |

**Migration gate:** complete. **Productization gate:** in progress. The checklists below remain acceptance criteria and are intentionally not marked complete when only a baseline subset exists.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing MiniCode runtime skeleton into a usable local coding assistant with DeepSeek tool calling, persistent projects and sessions, and a Codex-style three-pane web workspace.

**Architecture:** Keep the model-driven `QueryLoop` and `HarnessRuntime` as the single execution path. Add a provider adapter for DeepSeek, application services for project/session/run lifecycle, and a React client that consumes the FastAPI REST and SSE APIs.

**Tech Stack:** Python 3.11+, FastAPI, SQLite, OpenAI-compatible Python SDK, DeepSeek API, React, TypeScript, Vite, SSE, pytest, Vitest.

## Global Constraints

- API keys are read only from server-side environment variables; never persist or expose them through the browser.
- Every workspace file write, shell command, git write, or test execution passes through `HarnessRuntime`.
- Paths must remain constrained by `WorkspaceManager`.
- `deepseek-v4-flash` is the default tool-calling model; model selection is project-scoped and configurable.
- A project stores portable runtime artifacts in `<workspace>/.minicode/`; global project/session indexes live under the user's MiniCode home directory.
- Long-term memory is strictly project-isolated. No rule, preference, summary, artifact, or retrieval result from Project A may be used by Project B.
- Project rules can be automatically proposed and persisted only after privacy filtering, confidence validation, deduplication, and an audit event. The UI must let the user inspect, edit, disable, or delete every stored rule.
- Secrets and sensitive values are never written to memory, conversation summaries, artifacts intended for model context, audit events, or browser responses.
- The UI uses only `minicode` APIs.

---

## Current Baseline

| Area | Status | Evidence / gap |
|---|---|---|
| Tool-use loop | Partial, executable | `QueryLoop` executes one model-requested tool at a time and emits events, but only its scripted demo model is wired in. |
| File and search tools | Implemented baseline | `list_directory`, `glob_files`, `grep`, `read_file` work inside an explicit workspace. |
| Editing and execution | Implemented baseline | Patch proposal/application, tests, git read tools and fallback bash exist; writes and bash require policy approval. |
| Security policy | Implemented baseline | Workspace escape is blocked; plan mode is read-only; approval decision is emitted but cannot yet be resumed by a service/API. |
| DeepSeek model | Missing | The project has the OpenAI SDK dependency, but only `JsonScriptModel` is implemented. |
| Session persistence | Partial | A `SessionState` JSON payload is saved in per-workspace SQLite; there is no list, append-message, resume, project registry, or global history service. |
| Context compression | Prototype | Recent messages are retained and older messages are truncated into a string; `TokenBudget` is unused and no LLM summary, priority budget, or persistent compact checkpoint exists. |
| Artifact management | Implemented baseline | Large tool output can be written to `.minicode/runs/<run>/artifacts`; artifact retrieval is not exposed to UI/model tools. |
| Markdown memory | Prototype | Markdown file creation and a flat index exist; there is no rule loader, path matching, memory retrieval, automatic extraction, or context injection. |
| Multi-agent | Not implemented | The fixed multi-agent prototype was removed; no `task_agent` tool or isolated subagent runtime exists yet. |
| Web product | Missing | The new FastAPI daemon exposes run/status/SSE JSON endpoints only. Legacy static UI is bound to the old runtime and is not a migration target. |

## Target User Experience

```text
Left: Projects and Sessions     Center: Conversation and Run Flow     Right: Workspace Context
---------------------------     ----------------------------------     ------------------------
Open local project              Task input and mode selector           File tree
Create / rename session         Assistant messages                     Read-only file viewer
Recent sessions grouped         Expandable tool cards                  Patch / diff preview
Search session history          Approval prompt and controls           Plan, tests, artifacts tabs
```

The UI opens a local project, creates or continues a session, and starts a run. SSE renders lifecycle and tool events in the center. Selecting an active file, diff, test result, or artifact renders its details in the right pane. A destructive action pauses in the center until the user explicitly approves or rejects it.

## Approved Memory Design

### Scope and Storage

Every project owns one isolated memory root:

```text
<workspace>/.minicode/
  memory/
    MEMORY.md                 # small index and enabled/disabled rule metadata
    rules/                    # durable project conventions and conditional rules
    decisions/                # explicit architectural or workflow decisions
    failures/                 # reusable failure diagnosis and recovery steps
    summaries/                # compact checkpoints for completed sessions
    candidates/               # newly inferred rules awaiting confidence promotion
```

The global MiniCode database may store only the project ID, workspace path, and session index required to reopen a project. It must not store project memory content or make one project's memory searchable from another project.

### Memory Classes

| Class | Contains | Persistence | How it is retrieved |
|---|---|---|---|
| Short-term working memory | Current task, current plan, active files, last messages, recent tool-result previews | `SessionState` and current run | Included in every model request within the explicit token budget. |
| Medium-term session memory | Structured compact summary, completed decisions, changed files, test outcome, artifact references | Session payload plus `memory/summaries/` after completion/compaction | Loaded only when that exact session is reopened; summary is placed before recent turns. |
| Long-term project memory | Coding conventions, commands, architecture decisions, path-specific rules, recurring failures | Project-local Markdown files under `memory/` | `MEMORY.md` is read first; only relevant rule files are selected by task, active path and metadata. |

### Automatic Write Policy

The agent may write a candidate memory only when the fact is stable and reusable. Examples: a verified test command, an explicit user instruction, a project convention confirmed by repository configuration, or a repeated failure with a verified resolution. It must not save transient task details, speculative conclusions, unverified model assumptions, raw chat prose, or source-code copies.

The write pipeline is:

```text
Tool result / explicit user instruction / verified outcome
  -> candidate extraction
  -> secret and sensitive-data scrub
  -> evidence and confidence check
  -> duplicate / contradiction check
  -> write Markdown rule + update MEMORY.md index
  -> persist audit event + emit UI event
```

Promotion rules:

- Direct user instruction or repository-declared configuration: promote immediately.
- A fact verified by a successful tool result: promote when it is clearly reusable and includes evidence.
- A pattern inferred by the model: create under `candidates/` first; promote only after it is independently confirmed in a later task or by an explicit user action.
- A later contradictory fact disables the old rule and records the replacement; it does not silently overwrite history.

### Privacy and Sensitive-Data Policy

Before any compact summary, artifact preview, audit record, candidate, or long-term memory write, run a shared `SensitiveDataFilter`. It must redact or reject at least API keys, bearer tokens, passwords, cookies, private keys, connection strings, credentials embedded in URLs, identity documents, email addresses and phone numbers when they are not necessary for the task.

The filter must operate before persistence and before model-context construction. A detected secret becomes a short UI-safe notice such as `Sensitive value redacted`; the original value is not copied to any new storage location. `.env`, credential files, and known secret paths are treated as no-memory sources by default.

### Retrieval Rules

Memory is never appended wholesale to a prompt. For each model step, `MemoryService` performs these selections in order:

1. Load the project's small `MEMORY.md` index.
2. Add user-explicit rules and project-wide rules marked enabled.
3. Match conditional rules against active file paths and task keywords.
4. Add only the most relevant failure/decision notes within the memory budget.
5. Record the memory references used in the run audit trail.

Source-code understanding remains `Glob -> Grep -> Read`; long-term memory supplements repository facts and must not replace direct verification.

## Delivery Order

### Milestone 1: Real DeepSeek Tool Calling

**Files:**
- Create: `src/minicode/engine/providers/__init__.py`
- Create: `src/minicode/engine/providers/deepseek.py`
- Create: `src/minicode/engine/model_factory.py`
- Modify: `src/minicode/engine/model_client.py`
- Modify: `src/minicode/interfaces/cli.py`
- Modify: `src/minicode/interfaces/web/server.py`
- Create: `tests/test_deepseek_model.py`

- [ ] Write failing tests for translating `ToolSpec` into OpenAI function schemas, parsing a final response, parsing a tool-call response, and rejecting malformed provider responses.
- [ ] Implement a `DeepSeekModelClient(ModelClient)` that uses `OpenAI(base_url=..., api_key=...)` and invokes chat completions with the visible tools.
- [ ] Implement `ModelFactory.from_environment()` that loads `.env`, validates `DEEPSEEK_API_KEY`, provider, model and base URL, and returns a test-friendly error without exposing the key.
- [ ] Wire the factory into CLI and daemon startup; preserve `--mock` to select `JsonScriptModel` intentionally.
- [ ] Verify adapter tests without network access, then run the entire Python test suite.

**Acceptance criteria:** `minicode -w <workspace> "read the README"` uses DeepSeek when configured; a model tool call is always executed by `HarnessRuntime`, never directly by the provider adapter.

### Milestone 2: Project, Session, and Run Lifecycle

**Files:**
- Create: `src/minicode/application/project_service.py`
- Create: `src/minicode/application/session_service.py`
- Create: `src/minicode/application/approval_service.py`
- Create: `src/minicode/storage/global_store.py`
- Modify: `src/minicode/storage/sqlite_store.py`
- Modify: `src/minicode/application/run_service.py`
- Modify: `src/minicode/interfaces/web/server.py`
- Create: `tests/test_project_service.py`
- Create: `tests/test_session_service.py`
- Create: `tests/test_approval_service.py`

- [ ] Introduce global `projects`, `sessions`, `runs`, and `events` tables, with project root paths, timestamps, titles, mode, model configuration and status indexes.
- [ ] Add project APIs: create/open, list, update display metadata, and validate that the chosen path is a readable directory before it becomes a project workspace.
- [ ] Add session APIs: create, list per project, fetch complete state, rename, append user messages, and archive. Preserve session messages and tool-call records instead of creating a new session per prompt.
- [ ] Add run APIs: start a run for a session, stream persisted and live events, retrieve artifacts, cancel a running run, and safely resume an approval-paused run with an explicit decision.
- [ ] Keep in-memory queues as a live-delivery optimization only; SQLite becomes the source of truth after a daemon restart.
- [ ] Verify restarts can list prior projects and sessions, reload a completed session, and resume an approved paused call exactly once.

**Acceptance criteria:** a user can close and reopen the daemon, select a previous project, see its sessions, open one, and continue the conversation without losing prior task state.

### Milestone 3: Context, Artifacts, and Markdown Memory

**Files:**
- Create: `src/minicode/context/context_projector.py`
- Create: `src/minicode/context/file_state_cache.py`
- Create: `src/minicode/memory/rule_loader.py`
- Create: `src/minicode/memory/memory_service.py`
- Create: `src/minicode/memory/candidate_extractor.py`
- Create: `src/minicode/memory/sensitive_data_filter.py`
- Create: `src/minicode/memory/memory_audit.py`
- Modify: `src/minicode/context/context_manager.py`
- Modify: `src/minicode/context/compact_manager.py`
- Modify: `src/minicode/context/token_budget.py`
- Modify: `src/minicode/memory/markdown_memory.py`
- Modify: `src/minicode/engine/query_loop.py`
- Create: `tests/test_context_manager.py`
- Create: `tests/test_rule_loader.py`
- Create: `tests/test_memory_service.py`
- Create: `tests/test_sensitive_data_filter.py`
- Create: `tests/test_candidate_extractor.py`

- [ ] Define an explicit context budget per section: system, project rules, task, plan, active files, recent messages and recent tool results.
- [ ] Replace character-only truncation with deterministic compaction checkpoints: retain recent turns verbatim, turn older turns into a structured summary, scrub sensitive values, and persist the summary in `SessionState.compact_summary` plus project-local session summaries.
- [ ] Implement `SensitiveDataFilter` before every persistence or context projection operation. It must prevent secrets and sensitive values from entering long-term memory, compact summaries, audit payloads, artifact previews, or API responses.
- [ ] Load `MEMORY.md` as an index and selectively load Markdown rules based on task, file-path frontmatter matches and a strict memory budget. Do not inject all memory files into every request.
- [ ] Implement automatic candidate extraction with evidence, confidence, duplication and contradiction checks. Promote explicit instructions and verified facts; retain unverified inferences as candidates until independently confirmed.
- [ ] Record artifact metadata and memory references in session/run state and make sanitized artifacts readable through a restricted API and a read-only tool.
- [ ] Add UI/API operations to inspect, edit, disable and delete project memory. All memory changes create audit events.
- [ ] Verify project isolation, bounded prompt size, path-matched rule selection, secret redaction, candidate promotion, artifact references and persisted compact summaries.

**Acceptance criteria:** long sessions remain inside the configured context budget, old details remain traceable through summaries/artifacts, only relevant rules enter a model request, project memory cannot leak across projects, and no sensitive value is persisted or sent through the UI/event stream.

### Milestone 4: Controlled SubAgent as a Tool

**Files:**
- Create: `src/minicode/engine/subagent.py`
- Create: `src/minicode/tools/task_tools.py`
- Modify: `src/minicode/tools/base.py`
- Modify: `src/minicode/runtime/policy_engine.py`
- Modify: `src/minicode/engine/query_loop.py`
- Create: `tests/test_task_agent.py`

- [ ] Define `task_agent` as a normal `ToolSpec`, not a fixed graph node.
- [ ] Support read-only `explorer` and `reviewer` templates first, each with an allowlisted tool subset, a maximum turn/tool budget, and separate context.
- [ ] Return only structured summary, findings, active files and artifact references to the parent session; do not merge raw subagent messages.
- [ ] Require explicit policy approval before any future subagent receives write-capable tools.
- [ ] Verify subagents cannot escape their workspace, cannot exceed their tool budget, and cannot invoke a non-allowlisted tool.

**Acceptance criteria:** the main agent can delegate repository exploration or diff review without reintroducing the legacy fixed Master-Specialist workflow.

### Milestone 5: Codex-Style Three-Pane Web Client

**Files:**
- Create: `web/package.json`
- Create: `web/vite.config.ts`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/api/client.ts`
- Create: `web/src/state/project-store.ts`
- Create: `web/src/components/ProjectSidebar.tsx`
- Create: `web/src/components/SessionList.tsx`
- Create: `web/src/components/ConversationPane.tsx`
- Create: `web/src/components/RunTimeline.tsx`
- Create: `web/src/components/ContextPane.tsx`
- Create: `web/src/components/FileTree.tsx`
- Create: `web/src/components/DiffViewer.tsx`
- Create: `web/src/styles/app.css`
- Modify: `src/minicode/interfaces/web/server.py`
- Create: `tests/web/*.test.tsx`

- [ ] Scaffold a separate React + TypeScript + Vite client and configure FastAPI to serve its production build in local-daemon mode.
- [ ] Implement the left pane: project switcher, open-folder action, new session command, session history and archive controls.
- [ ] Implement the center pane: persistent message timeline, mode selector, task composer, SSE run timeline, collapsible tool results, and approve/reject controls for paused actions.
- [ ] Implement the right pane: file tree, syntax-highlighted read-only file viewer, diff tab, plan tab, test/output tab and artifact tab.
- [ ] Make viewport state responsive: on narrow screens, retain the conversation pane and expose left/right panes through icon-triggered drawers.
- [ ] Test empty, loading, failed, disconnected, approval-required and restored-session states; validate no API response includes secret configuration.

**Acceptance criteria:** a user can manage multiple local projects and independent conversations in a single UI, observe every model/tool action, inspect files and diffs, and approve controlled writes.

### Milestone 6: Observability, Evaluation, and Migration Closure

**Files:**
- Create: `src/minicode/observability/__init__.py`
- Create: `src/minicode/observability/audit.py`
- Create: `src/minicode/observability/trace.py`
- Create: `src/minicode/evals/scenarios.py`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/01_项目目标与架构设计.md`
- Create: `tests/test_audit.py`

- [ ] Persist append-only run traces with model metadata, tool requests, policy decisions, approvals, duration and artifact references, excluding prompt secrets.
- [ ] Add deterministic evaluation scenarios for repository discovery, read-only planning, denied plan-mode writes, approved patching, failed tests and context compaction.
- [ ] Publish a release note documenting the removal of the old prototype and the active `minicode` runtime.
- [ ] Run full test suites for Python and web client and perform an end-to-end DeepSeek smoke test against a disposable workspace.

**Acceptance criteria:** runs are auditable and reproducible enough to debug regressions, and the team has a measured basis for retiring the old prototype.

## Deferred Deliberately

- Vector database and semantic code RAG: add only when Markdown memory plus `Glob -> Grep -> Read` proves insufficient for a measured use case.
- Autonomous memory writes: require retrieval evaluation and user controls first.
- Parallel write-capable subagents: too much coordination and safety complexity before the core session/runtime path is stable.
- Remote/multi-user daemon deployment: retain local-first operation until authentication, tenant isolation and secret management have a concrete requirement.

## Release Gates

1. Milestone 1 must complete before using the new runtime interactively.
2. Milestone 2 must complete before building session-history UI.
3. Milestones 3 and 4 may proceed independently after Milestone 2, but both must be complete before claiming production-grade agent behavior.
4. Milestone 5 depends on Milestone 2 APIs and should use stable event contracts from Milestone 1.
5. Milestone 6 closes the first productization cycle; it is not a license to delete the legacy prototype prematurely.

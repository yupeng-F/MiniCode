# MiniCode Harness Integration Design

## 1. Goal

Integrate Harness Engineering into MiniCode without changing `/Users/fish/Code/harness`.
MiniCode will provide a project-owned compatibility layer for Harness commands and a
project-owned specification overlay for its Python/FastAPI and React/Vite stack.

The integration must let Harness plan, execute, review, and verify MiniCode work
without interpreting MiniCode as a Fastify/Vue project.

## 2. Non-goals

- Do not modify Harness Engineering source files.
- Do not migrate MiniCode from React to Vue or from Python to Node.js.
- Do not replace MiniCode's internal `HarnessRuntime`; it is a product component,
  distinct from the external Harness Engineering framework.
- Do not add Test/Production deployment or cloud-native delivery in this phase.
- Do not call a real LLM or require an API key in automated tests.
- Do not build the full Playwright user-journey suite in this phase.

## 3. Terminology and ownership

- **Harness Engineering**: the external development-governance framework installed
  into MiniCode.
- **MiniCode Harness Runtime**: MiniCode's internal safe tool-execution boundary.
- **Shared Harness files**: files copied by the Harness installer and replaced by a
  later Harness sync.
- **MiniCode overlay**: project-owned configuration and documentation reapplied after
  every Harness sync.

Harness owns generic workflow rules. MiniCode owns its architecture, technology
choices, verification commands, and project-specific acceptance criteria.

## 4. Architecture

The integration has three project-owned layers:

1. A root pnpm interface that exposes the command names Harness already calls.
2. A modular Node.js adapter that executes MiniCode's real Python and Web checks.
3. A specification overlay that redirects installed task rules away from
   Fastify/Vue assumptions and toward MiniCode documents.

```text
Harness task or quality script
        |
        v
pnpm typecheck | lint | test | build | test:e2e
        |
        v
tools/harness-check.mjs
        |
        +--> Python: mypy / ruff / pytest / build
        +--> Web: TypeScript / ESLint / Vitest / Vite

Harness sync
        |
        v
pnpm harness:overlay
        |
        v
MiniCode task-rule references and acceptance criteria restored
        |
        v
pnpm harness:doctor
```

## 5. Command adapter

### 5.1 Public interface

MiniCode's root `package.json` will expose:

| Script | Purpose |
|---|---|
| `pnpm typecheck` | Python and Web type checking |
| `pnpm lint` | Python and Web linting plus dependency consistency checks |
| `pnpm test` | Python and Web unit/integration tests |
| `pnpm build` | Python wheel and production Web bundle |
| `pnpm test:e2e` | Offline CLI and Web smoke tests |
| `pnpm harness:overlay` | Reapply MiniCode task-rule overrides after Harness sync |
| `pnpm harness:doctor` | Validate files, dependencies, commands, and active overlay |

### 5.2 Internal modules

```text
tools/
  harness-check.mjs          # CLI entry point and command dispatch
  harness/
    command-runner.mjs       # sequential fail-fast process execution
    config-loader.mjs        # load and validate MiniCode adapter configuration
    overlay.mjs              # deterministic task-rules.yml transformation
    doctor.mjs               # read-only installation and configuration checks
```

The CLI entry point stays small. Each module has one responsibility and can be unit
tested without running the full Harness workflow.

### 5.3 Command configuration

`config/minicode-harness.yml` is the MiniCode-owned source of truth. Commands are
stored as executable-plus-argument arrays rather than shell strings, avoiding shell
quoting and command-injection ambiguity.

The initial command graph is:

| Phase | Commands, in order |
|---|---|
| `typecheck` | `python -m mypy src/minicode`; `npm --prefix web run typecheck` |
| `lint` | `python -m ruff check src/minicode tests`; `python -m pip check`; `npm --prefix web run lint`; `npm --prefix web audit --audit-level=high` |
| `test` | `python -m pytest`; `npm --prefix web test` |
| `build` | `python -m build --wheel`; `npm --prefix web run build` |
| `test:e2e` | `python -m pytest tests/test_harness_smoke.py` |

Commands execute sequentially. The first non-zero result stops the phase and the
adapter returns the same non-zero result. Output is streamed directly so Harness and
CI preserve the original failure evidence.

## 6. Minimal smoke coverage

`tests/test_harness_smoke.py` will cover two offline product entry points:

1. Launch `python -m minicode.interfaces.cli --mock --workspace <temp-dir>` and
   verify successful completion and the mock-loop final answer.
2. Use FastAPI `TestClient` with a temporary global-store path, request `/`, and
   verify that MiniCode identifies itself and reports the expected architecture.

This is a real CLI/Web smoke test but not the final user-journey E2E suite. Full
Playwright scenarios will be added by later feature sprints after Harness installation.

## 7. MiniCode project specifications

The following project-owned documents will be added:

| File | Responsibility |
|---|---|
| `ARCHITECTURE.md` | Compact Harness entry point; links to `docs/01_项目目标与架构设计.md` as the detailed architecture source |
| `PROJECT_RULES.md` | Python/React rules, module boundaries, Runtime safety invariants, and pre-commit requirements |
| `USER_STORIES.md` | Product backlog and automatically verifiable acceptance criteria |
| `docs/MINICODE_BACKEND.md` | FastAPI, Pydantic, SQLite, error handling, persistence, and concurrency rules |
| `docs/MINICODE_FRONTEND.md` | React, Vite, API client, UI state, accessibility, and build rules |
| `docs/MINICODE_TESTING.md` | pytest/Vitest/smoke layers, mock boundaries, coverage, and real-model test policy |

These documents describe MiniCode only. Generic Sprint, review, release, and
observability rules remain owned by Harness Engineering.

## 8. Task-rule overlay

The Harness installer copies `lint/task-rules.yml`, whose current frontend and backend
rules assume Vue and Fastify. MiniCode cannot use those task references unchanged.

`config/minicode-harness.yml` will declare deterministic overrides for these tasks:

- `design`: use the generic design philosophy plus `docs/MINICODE_FRONTEND.md`, not
  the Vue-specific UI baseline.
- `backend-design`: use `docs/MINICODE_BACKEND.md`.
- `frontend-design`: use `docs/MINICODE_FRONTEND.md`.
- `code`: use MiniCode backend/frontend specifications and MiniCode verification
  commands while retaining the generic code-review specification.
- `test-case-gen` and `quality`: use `docs/MINICODE_TESTING.md` for project-specific
  test structure and acceptance evidence.

The overlay transforms only declared fields. Unrelated Harness tasks and future
unknown fields remain untouched. Applying the overlay twice produces byte-equivalent
task semantics, making the operation idempotent.

After every Harness sync the required sequence is:

```bash
pnpm harness:overlay
pnpm harness:doctor
```

`doctor` fails if task rules still reference Vue/Fastify acceptance criteria, required
MiniCode documents are missing, command dependencies are unavailable, or the overlay
has not been applied.

## 9. Tooling changes

Python development dependencies will include:

- `pytest`
- `mypy`
- `ruff`
- `build`

Web development tooling will add explicit `typecheck` and `lint` scripts plus the
minimal ESLint packages needed for React and TypeScript. The existing npm-managed
`web/package-lock.json` remains authoritative for Web dependencies. Root pnpm is only
the Harness-facing command interface and overlay tool host.

The root package will depend on a YAML parser for validated command and overlay
configuration. No general-purpose task-runner dependency is introduced.

## 10. Error handling and safety

- Unknown adapter phases fail with a usage message and non-zero status.
- Invalid or missing YAML fields fail before any command or overlay write.
- The overlay resolves and validates the MiniCode repository root before writing.
- The overlay may write only `lint/task-rules.yml` inside the MiniCode repository.
- `doctor` is read-only.
- Smoke tests use temporary directories and temporary SQLite files.
- No test reads user-level MiniCode state or real API credentials.
- Command output never embeds environment-variable values.

## 11. Verification strategy

Implementation follows test-driven development:

1. Unit-test configuration validation and command planning.
2. Unit-test fail-fast exit propagation with controlled child processes.
3. Unit-test task-rule overlay transformation and idempotence using temporary YAML.
4. Unit-test doctor failure messages for missing and stale overlay state.
5. Add failing CLI/Web smoke tests, then implement only required test wiring.
6. Run each public pnpm command independently.
7. Run the complete Python and Web suites.
8. Confirm `/Users/fish/Code/harness` has no modified files.

## 12. Delivery sequence

1. Implement and verify the MiniCode compatibility layer and specifications.
2. Commit the compatibility layer separately.
3. Run Harness `--dry-run` against MiniCode.
4. Install Harness with `--no-commit`.
5. Reapply the MiniCode overlay and run `doctor`.
6. Review the install diff and commit the Harness installation separately.
7. Start the first Harness feature sprint from `USER_STORIES.md`.


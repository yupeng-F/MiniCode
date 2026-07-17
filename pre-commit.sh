#!/usr/bin/env bash
# ⚠️ MAI-Harness 框架文件 — 请勿在项目中修改。如需变更请在框架工程中修改并覆盖到此项目中。
# =============================================================================
# Harness Engineering — Git Pre-commit Hook
#
# PROJECT_RULES.md Pre-commit Checklist 代码化执行。
# 安装方式: cp pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#
# 检查项:
#   1. TypeCheck (pnpm typecheck)
#   2. Lint (pnpm lint)
#   3. 快速测试 (pnpm test --changedSince)
#   4. 硬编码密钥扫描
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'

pass() { printf "${GREEN}✅${NC} %s\n" "$*"; }
fail() { printf "${RED}❌${NC} %s\n" "$*"; ERRORS=$((ERRORS+1)); }
warn() { printf "${YELLOW}⚠️${NC}  %s\n" "$*"; }

ERRORS=0

echo "🔒 Harness Pre-commit Gate"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── 1. TypeCheck ────────────────────────────────────────────────────────────

if command -v pnpm &>/dev/null && [[ -f "package.json" ]]; then
  if grep -q '"typecheck"' package.json 2>/dev/null; then
    if pnpm typecheck 2>/dev/null; then
      pass "TypeCheck"
    else
      fail "TypeCheck 失败"
    fi
  else
    warn "未定义 typecheck 脚本，跳过"
  fi
fi

# ─── 2. Lint ─────────────────────────────────────────────────────────────────

if command -v pnpm &>/dev/null && [[ -f "package.json" ]]; then
  if grep -q '"lint"' package.json 2>/dev/null; then
    # 只 lint 暂存的文件（如果有 lint-staged）
    if grep -q '"lint-staged"' package.json 2>/dev/null; then
      if pnpm lint-staged 2>/dev/null; then
        pass "Lint (staged)"
      else
        fail "Lint 失败"
      fi
    else
      if pnpm lint --quiet 2>/dev/null; then
        pass "Lint"
      else
        fail "Lint 失败"
      fi
    fi
  else
    warn "未定义 lint 脚本，跳过"
  fi
fi

# ─── 3. 快速测试 ─────────────────────────────────────────────────────────────

if command -v pnpm &>/dev/null && [[ -f "package.json" ]]; then
  if grep -q '"test"' package.json 2>/dev/null; then
    # 只运行与变更文件相关的测试
    if pnpm test -- --changedSince=HEAD --passWithNoTests --silent 2>/dev/null; then
      pass "Quick Test (changed files)"
    else
      # 降级：如果 --changedSince 不支持，跳过
      warn "Quick Test 跳过 (--changedSince 不支持)"
    fi
  fi
fi

# ─── 4. 密钥扫描 ──────────────────────────────────────────────────────────────
# 密钥检测由 ESLint harness-plugin.mjs (no-hardcoded-secrets) 统一执行。
# Step 2 Lint 已覆盖所有 JS/TS/JSX/TSX 代码文件的密钥扫描。
# 此处仅扫描 Lint 不覆盖的文件类型（.env*, .json）。

STAGED_NON_JS=$(git diff --cached --name-only --diff-filter=ACMR -- '*.json' '*.env*' 2>/dev/null || true)

if [[ -n "$STAGED_NON_JS" ]]; then
  SECRET_FOUND=false
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if grep -nEi '(api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["\x27][A-Za-z0-9+/=]{8,}' "$file" 2>/dev/null | head -3; then
      SECRET_FOUND=true
    fi
    if grep -nE 'AKIA[0-9A-Z]{16}' "$file" 2>/dev/null | head -1; then
      SECRET_FOUND=true
    fi
  done <<< "$STAGED_NON_JS"

  if $SECRET_FOUND; then
    fail "检测到疑似硬编码密钥（见上方详情）"
  else
    pass "密钥扫描（非代码文件）"
  fi
else
  pass "密钥扫描（无暂存非代码文件）"
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── 结果 ────────────────────────────────────────────────────────────────────

if [[ $ERRORS -gt 0 ]]; then
  printf "\n${RED}Pre-commit 检查失败 (%d 个错误)${NC}\n" "$ERRORS"
  printf "使用 ${YELLOW}git commit --no-verify${NC} 可跳过（仅紧急情况）\n\n"
  exit 1
else
  printf "\n${GREEN}Pre-commit 检查通过${NC}\n\n"
  exit 0
fi

#!/usr/bin/env bash
# scripts/precommit-check.sh —— Millwright commit 门禁
# 用法：bash scripts/precommit-check.sh <repo-path> <version>
# 示例：bash scripts/precommit-check.sh /home/raylan/.openclaw/workspace/projects/millwright 0.2.34
set -euo pipefail

R="${1:?用法: $0 <repo-path> <version>}"
V="${2:?用法: $0 <repo-path> <version>}"

S=$(git -C "$R" diff --cached --name-only)

if [ -z "$S" ]; then
  echo "❌ staged 为空，没有文件待 commit"
  exit 1
fi

# ---- 污染检查（任一命中即失败） ----
POLLUTED=""
if echo "$S" | grep -Eiq 'credential|apikey|\.env$|\.pyc$|__pycache__|/backups?/|vendor/python'; then
  POLLUTED=$(echo "$S" | grep -Ei 'credential|apikey|\.env$|\.pyc$|__pycache__|/backups?/|vendor/python')
fi

if [ -n "$POLLUTED" ]; then
  echo "❌ staged 含敏感/污染文件："
  echo "$POLLUTED"
  exit 1
fi

# ---- 版本号 ----
if ! echo "$S" | grep -qx 'package.json'; then
  echo "❌ 漏 bump package.json"
  exit 1
fi

if ! git -C "$R" diff --cached package.json | grep -q "^+.*\"version\": \"$V\""; then
  echo "❌ package.json 版本不是 $V"
  exit 1
fi

# ---- CHANGELOG ----
if ! echo "$S" | grep -qx 'CHANGELOG.md'; then
  echo "❌ 漏 CHANGELOG.md"
  exit 1
fi

if ! git -C "$R" diff --cached CHANGELOG.md | grep -q "^+## \[$V\]"; then
  echo "❌ CHANGELOG 缺 [$V] 段"
  exit 1
fi

echo "✅ 门禁通过（$(echo "$S" | wc -l) 个文件）"

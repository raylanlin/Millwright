#!/usr/bin/env bash
# scripts/precommit-check.sh —— Millwright commit 门禁
#
# 用法：
#   bash scripts/precommit-check.sh <repo-path> <version>                 # 发版（要求 bump package.json + CHANGELOG [V]）
#   bash scripts/precommit-check.sh <repo-path> --docs-only               # 文档修订（跳过版本号检查，但有护栏）
#
# 示例：
#   bash scripts/precommit-check.sh /home/raylan/.openclaw/workspace/projects/millwright 0.2.34
#   bash scripts/precommit-check.sh /home/raylan/.openclaw/workspace/projects/millwright --docs-only
#
# 检查项（两种模式都跑）：
#   1. 工作树污染（credential / apikey / .env / .pyc / __pycache__ / backups / vendor/python）
#   2. -m compileall 整个 sidecar（仅当 sidecar/ 在 staged 里）
#   3. 边车启动握手（CI 上不阻塞，本地参考）
#
# 仅发版模式额外检查：
#   - package.json bump 到指定版本
#   - CHANGELOG.md 含 [V] 段
#
# --docs-only 护栏（任一命中即失败）：
#   - src/、sidecar/（除 *.md）、electron-builder.yml、package.json
#   - .github/、*.eslintrc.json / *.prettierrc* / *.ruff.toml / .npmrc 等配置
#   - scripts/（除本门禁脚本本身）
#   - 任何构建产物 / 锁文件
#   配套规则见 TOOLS.md「规则 3：commit 前跑门禁脚本」段。
set -euo pipefail

R="${1:?用法: $0 <repo-path> <version|--docs-only>}"
V="${2:?用法: $0 <repo-path> <version|--docs-only>}"

DOCS_ONLY=0
if [ "$V" = "--docs-only" ]; then
  DOCS_ONLY=1
  V=""  # 文档修订不强制版本号
fi

S=$(git -C "$R" diff --cached --name-only)

if [ -z "$S" ]; then
  echo "❌ staged 为空，没有文件待 commit"
  exit 1
fi

# ---- --docs-only 护栏（先于一切检查） ----
if [ "$DOCS_ONLY" = "1" ]; then
  # 只允许：任意 *.md / *.txt / 根级纯文档 / 本门禁脚本本身
  # 其余全部 reject。
  BAD=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      # 唯一允许的非 *.md 例外：本门禁脚本本身（要随 --docs-only 提交一起改）
      scripts/precommit-check.sh) continue ;;
      # 文档
      *.md|*.txt) continue ;;
      AUTHORS.md|CODE_OF_CONDUCT.md|SECURITY.md|LICENSE) continue ;;
      # 根级 README 双语（虽然带后缀是 .md，但显式放行防漏）
      README.md|README.zh-CN.md) continue ;;
      # 其它一律不接受
      *)
        BAD="$BAD\n  $f"
        ;;
    esac
  done <<EOF
$S
EOF

  if [ -n "$BAD" ]; then
    echo "❌ --docs-only 模式下 staged 含非文档文件："
    printf "$BAD\n"
    echo ""
    echo "有代码改动不能用 --docs-only。请去掉旗标，正常走发版门禁（要求"
    echo "bump package.json + CHANGELOG [V] 段）。"
    exit 1
  fi
  echo "  --docs-only 护栏：通过（仅文档文件）"
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

# ---- 版本号 + CHANGELOG（仅发版模式） ----
if [ "$DOCS_ONLY" = "0" ]; then
  if ! echo "$S" | grep -qx 'package.json'; then
    echo "❌ 漏 bump package.json"
    exit 1
  fi

  if ! git -C "$R" diff --cached package.json | grep -q "^+.*\"version\": \"$V\""; then
    echo "❌ package.json 版本不是 $V"
    exit 1
  fi

  if ! echo "$S" | grep -qx 'CHANGELOG.md'; then
    echo "❌ 漏 CHANGELOG.md"
    exit 1
  fi

  if ! git -C "$R" diff --cached CHANGELOG.md | grep -q "^+## \[$V\]"; then
    echo "❌ CHANGELOG 缺 [$V] 段"
    exit 1
  fi
else
  # --docs-only 模式：纯文档修订，校验 CHANGELOG [Unreleased] 段确实被改动
  # （至少有新条目，不是空 section）
  if ! echo "$S" | grep -qx 'CHANGELOG.md'; then
    echo "❌ --docs-only 模式也要求 CHANGELOG.md 记录本次变更（[Unreleased] 段）"
    exit 1
  fi
  if ! git -C "$R" diff --cached CHANGELOG.md | grep -qE '^\+##? ' ; then
    echo "⚠️  --docs-only 模式下 CHANGELOG.md 改动未新增 ### Changed 段，确认是否漏写"
  fi
fi

# ---- Python sidecar 语法 + 握手（P36，2026-07-25） ----
# typecheck / eslint / node test 只管 TS，Python 语法错（如残缺 raise 行）
# 不会被它们发现，但会直接炸掉整个 sidecar。
py=$(command -v python3 || command -v python)
if [ -n "$py" ] && [ -d "$R/sidecar/sw_agent" ]; then
  SIDECAR_FILES=$(echo "$S" | { grep -E '^sidecar/' || true; })
  if [ -n "$SIDECAR_FILES" ]; then
    "$py" -m compileall -q "$R/sidecar/sw_agent" || {
      echo "❌ Python 语法错误（sidecar 启动会 crash → VBS 回退）"
      exit 1
    }
    # 更强的：起一次边车看能否握手（需要 python 支持 json 输入）
    if echo '{"id":1,"method":"ping","params":{}}' | "$py" "$R/sidecar/_bootstrap.py" 2>&1 | grep -q 'ready'; then
      echo "  sidecar ping OK"
    else
      echo "  ⚠️  sidecar ping 未返回 ready（可能缺 win32com / 不在 Windows 上 — CI 可忽略）"
    fi
  fi
fi

if [ "$DOCS_ONLY" = "1" ]; then
  echo "✅ 门禁通过（--docs-only 模式，$(echo "$S" | wc -l) 个纯文档文件）"
else
  echo "✅ 门禁通过（$(echo "$S" | wc -l) 个文件，版本 $V）"
fi

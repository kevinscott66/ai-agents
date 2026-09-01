#!/usr/bin/env bash
# T-507 — Detect committed git conflict markers in tracked files.
#
# Exits 1 if any file contains a line starting with the canonical conflict
# markers ("<<<<<<<", "=======", or ">>>>>>>"). Intended for CI use so that
# auto-merges from autonomous agents cannot land unresolved conflicts (the
# 2026-05-23 incident blocked 6 of 9 PRs for exactly this reason — see
# .claude/memory/notes/pr-merge-lessons-2026-05-23.md).
#
# Usage:
#   .github/scripts/check-conflict-markers.sh           # scan all tracked files
#   .github/scripts/check-conflict-markers.sh path/...  # scan specific paths

set -euo pipefail

# Self-exclude: this script literally contains the marker strings in comments
# above, so we skip it. Also skip vendor / build / runtime dirs.
EXCLUDES=(
  ':!.github/scripts/check-conflict-markers.sh'
  ':!**/node_modules/**'
  ':!**/dist/**'
  ':!**/build/**'
  ':!**/.eliza/**'
  ':!agent/data/**'
)

if [ "$#" -gt 0 ]; then
  PATHS=("$@")
else
  PATHS=('.')
fi

# Use git grep so we only scan tracked files. -n shows line numbers, -P uses
# Perl regex so we can anchor at start-of-line to avoid matching the marker
# strings inside documentation or this script.
PATTERN='^(<{7}|={7}|>{7})( |$)'

ERRLOG=$(mktemp)
trap 'rm -f "$ERRLOG"' EXIT

set +e
MATCHES=$(git grep -nP "$PATTERN" -- "${PATHS[@]}" "${EXCLUDES[@]}" 2>"$ERRLOG")
RC=$?
set -e

# git grep: 0 — есть совпадения, 1 — их нет, всё остальное — сам grep не
# отработал (не репозиторий, битый pathspec, git без PCRE — тогда `-P` даёт
# 128). Аудит 2026-08-12: такой код раньше проваливался в ветку «чисто», и
# джоба оставалась вечно зелёной, ничего не проверив. Гейт, который не смог
# проверить, обязан закрываться, а не открываться.
if [ "$RC" -gt 1 ]; then
  echo "::error::check-conflict-markers: git grep завершился с кодом $RC — проверка не выполнена."
  cat "$ERRLOG" >&2
  exit 2
fi

# git grep returns 1 when no matches found — that's the success case here.
if [ "$RC" -eq 0 ] && [ -n "$MATCHES" ]; then
  echo "::error::Committed git conflict markers found in tracked files:"
  echo "$MATCHES"
  echo ""
  echo "Resolve the conflicts and remove the marker lines before pushing."
  exit 1
fi

echo "No conflict markers found."
exit 0

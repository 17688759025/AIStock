#!/usr/bin/env bash
set -euo pipefail
kind="${1:?capture or result required}"
case "$kind" in capture|result) ;; *) exit 2 ;; esac
trade_date="$(TZ=Asia/Shanghai date +%F)"
target="data/auction/${trade_date}.${kind}.json"
if [ ! -f "$target" ]; then
  echo "No $kind file to publish for $trade_date"
  exit 0
fi
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add -- "$target"
if git diff --cached --quiet; then exit 0; fi
git commit -m "Save auction $kind $trade_date"
for attempt in 1 2 3; do
  # Never force push or overwrite an immutable file in a rebase conflict.
  git pull --rebase origin main
  if git push origin main; then exit 0; fi
  sleep "$((attempt * 2))"
done
exit 1

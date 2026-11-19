#!/usr/bin/env bash
# Fork checks run before lint-staged. Rules: FORK_MAINTENANCE.md, "Enforcement".
d=$(dirname "$0")
bash "$d/merge-log.sh" || exit 1
bash "$d/docs.sh" || exit 1

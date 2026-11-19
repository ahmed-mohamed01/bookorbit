#!/usr/bin/env bash
# Shared helpers for the fork's git checks. Rules: FORK_MAINTENANCE.md, "Enforcement".
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1

FORK_UPSTREAM=upstream/main
FORK_DOC=FORK_MAINTENANCE.md

# Without the upstream remote nothing can be told apart, so the checks pass.
fork_has_upstream() {
  git rev-parse -q --verify "$FORK_UPSTREAM^{commit}" >/dev/null 2>&1
}

# Paths upstream owns: in upstream/main now, or where the fork last merged it.
fork_upstream_files() {
  local base
  base=$(git merge-base HEAD "$FORK_UPSTREAM" 2>/dev/null)
  {
    git ls-tree -r --name-only "$FORK_UPSTREAM"
    [ -n "$base" ] && git ls-tree -r --name-only "$base"
  } | sort -u
}

fork_merge_head() {
  git rev-parse -q --verify MERGE_HEAD 2>/dev/null
}

# Files this commit changes itself. In a merge, a file staged exactly as the
# merged-in side has it was checked where that side was committed.
fork_own_staged() {
  local staged mh theirs
  staged=$(git diff --cached --name-only --no-renames)
  if mh=$(fork_merge_head); then
    theirs=$(git diff --cached --name-only --no-renames "$mh")
    printf '%s\n' "$staged" | grep -xF -f <(printf '%s\n' "$theirs")
  else
    printf '%s\n' "$staged"
  fi
}

# This commit's own changes to files upstream owns.
fork_touched_upstream() {
  fork_own_staged | grep -v '^$' | grep -xF -f <(fork_upstream_files)
}

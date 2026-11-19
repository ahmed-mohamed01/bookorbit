#!/usr/bin/env bash
# A merge that brings in upstream commits must add an entry to the Merge log.
. "$(dirname "$0")/lib.sh"
fork_has_upstream || exit 0

mh=$(fork_merge_head)
if [ -z "$mh" ]; then
  # pre-merge-commit runs before MERGE_HEAD exists; git names the merge here.
  case "${GIT_REFLOG_ACTION:-}" in
    merge\ *)
      for arg in ${GIT_REFLOG_ACTION#merge }; do
        case "$arg" in -*) continue ;; esac
        mh=$(git rev-parse -q --verify "$arg^{commit}" 2>/dev/null) && break
      done ;;
  esac
fi
[ -n "$mh" ] || exit 0
# Only merges of upstream history that HEAD does not have yet.
git merge-base --is-ancestor "$mh" "$FORK_UPSTREAM" 2>/dev/null || exit 0
git merge-base --is-ancestor "$mh" HEAD 2>/dev/null && exit 0

merge_log() {
  awk '/^### Merge log/ { f = 1; next } f && /^(#|##|###) / { exit } f && NF'
}
before=$(git show "HEAD:$FORK_DOC" 2>/dev/null | merge_log | sort -u)
after=$(git show ":$FORK_DOC" 2>/dev/null | merge_log | sort -u)
added=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -v '^$')
[ -n "$added" ] && exit 0

echo "This merge brings in upstream commits, but $FORK_DOC has no new Merge log entry."
echo "Follow 'The merge ritual' in $FORK_DOC, add the entry (date, upstream commit,"
echo "conflicts and how they were resolved), stage it, and run git commit."
exit 1

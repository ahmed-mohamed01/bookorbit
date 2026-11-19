#!/usr/bin/env bash
# The fork's lines in upstream files (ignoring whitespace) may not grow by more
# than FORK_SURFACE_LIMIT in one commit unless the message has a Fork-Surface: line.
. "$(dirname "$0")/lib.sh"
fork_has_upstream || exit 0
FORK_SURFACE_LIMIT=20
msg_file=$1

# Upstream merges are checked by merge-log.sh instead.
fork_merge_head >/dev/null && exit 0
git rev-parse -q --verify HEAD >/dev/null || exit 0
grep -v '^#' "$msg_file" | grep -qiE '^Fork-Surface:[[:space:]]*[^[:space:]]' && exit 0

base=$(git merge-base HEAD "$FORK_UPSTREAM" 2>/dev/null) || exit 0
files=$(fork_touched_upstream)
[ -z "$files" ] && exit 0

# Per file: fork lines (added + deleted against upstream) before and after.
count() { awk '{ a = ($1 == "-") ? 0 : $1; d = ($2 == "-") ? 0 : $2; print $3 "\t" a + d }'; }
before=$(printf '%s\n' "$files" | xargs git diff -w --numstat --no-renames "$base" HEAD -- | count)
after=$(printf '%s\n' "$files" | xargs git diff --cached -w --numstat --no-renames "$base" -- | count)
report=$(awk -F'\t' '
  NR == FNR { b[$1] = $2; next }
  { a[$1] = $2 }
  END {
    for (f in b) if (!(f in a)) a[f] = 0
    for (f in a) { g = a[f] - b[f]; t += g; if (g) printf "  %4d  %s\n", g, f }
    printf "TOTAL %d\n", t
  }' <(printf '%s\n' "$before" | grep -v '^$') <(printf '%s\n' "$after" | grep -v '^$'))
total=$(printf '%s\n' "$report" | awk '/^TOTAL/ { print $2 }')
[ "$total" -le "$FORK_SURFACE_LIMIT" ] && exit 0

echo "This commit grows the fork's lines in upstream files by $total (limit $FORK_SURFACE_LIMIT, whitespace ignored):"
printf '%s\n' "$report" | grep -v '^TOTAL' | sort -k1,1nr
echo "Move the logic into fork-owned files and leave a smaller hook (FORK_MAINTENANCE.md,"
echo "'Guiding principle'). If it cannot move, add a line to the message:"
echo "  Fork-Surface: <why it has to live in the upstream file>"
exit 1

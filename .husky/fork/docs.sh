#!/usr/bin/env bash
# A commit that changes a file upstream owns must update FORK_MAINTENANCE.md too.
. "$(dirname "$0")/lib.sh"
fork_has_upstream || exit 0
[ "${FORK_DOCS_SKIP:-}" = "1" ] && exit 0

touched=$(fork_touched_upstream)
[ -z "$touched" ] && exit 0
git diff --cached --name-only | grep -qxF "$FORK_DOC" && exit 0

echo "This commit changes files upstream owns, but not $FORK_DOC:"
printf '%s\n' "$touched" | head -10 | sed 's/^/  /'
n=$(printf '%s\n' "$touched" | wc -l | tr -d ' ')
[ "$n" -gt 10 ] && echo "  ... and $((n - 10)) more"
echo "Read $FORK_DOC, record the change in its overlay section (and the conflict"
echo "surface table if a hook grew), stage it, and commit again."
exit 1

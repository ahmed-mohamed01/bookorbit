#!/usr/bin/env bash
# PreToolUse guard for Bash: agents may not skip or rewire the fork's git checks.
# The checks enforce FORK_MAINTENANCE.md ("Enforcement").
exec python3 -c '
import json, re, shlex, sys
cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "") or ""

def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
        "permissionDecision": "deny", "permissionDecisionReason": reason}}))
    sys.exit(0)

if re.search(r"\bHUSKY=|\bFORK_DOCS_SKIP=", cmd):
    deny("Turning the git hooks off (HUSKY, FORK_DOCS_SKIP) is not allowed for agents. Fix what the hook reports; see FORK_MAINTENANCE.md.")
if re.search(r"hooksPath|\.husky/_", cmd):
    deny("Changing where git hooks come from is not allowed for agents. Ask the user.")

try:
    toks = shlex.split(cmd, posix=True)
except ValueError:
    toks = cmd.split()

# Split into simple commands at shell operators.
cmds, cur = [], []
for t in toks:
    if t in (";", "&&", "||", "|", "&"):
        cmds.append(cur); cur = []
    else:
        cur.append(t)
cmds.append(cur)

TAKES_ARG = {"-m", "-F", "-c", "-C", "-t", "--message", "--file", "--author", "--date", "--cleanup", "--fixup", "--squash", "--trailer"}
for c in cmds:
    if "git" not in c:
        continue
    g = c[c.index("git") + 1:]
    if "--no-verify" in g:
        deny("Skipping git hooks (--no-verify) is not allowed in this repo. Fix what the hook reports; see FORK_MAINTENANCE.md.")
    if "commit" in g:
        skip = False
        for t in g[g.index("commit") + 1:]:
            if skip:
                skip = False; continue
            if t in TAKES_ARG:
                skip = True; continue
            if re.fullmatch(r"-[a-zA-Z]+", t):
                flags = t[1:]
                # -m/-F/-C/-c/-t take the rest as their argument
                for i, ch in enumerate(flags):
                    if ch == "n":
                        deny("git commit -n skips the hooks and is not allowed. Fix what the hook reports; see FORK_MAINTENANCE.md.")
                    if ch in "mFCct":
                        if i == len(flags) - 1: skip = True
                        break
'

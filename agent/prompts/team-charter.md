---
description: Ratify the project's Agentic Team Protocol charter and report proceed/no-proceed
---

# /team-charter

Read the project's `agentic-team-charter.md`, store a ratification record in Eden-memory, and report whether the team may proceed to production implementation.

## Steps

1. Determine the charter path (first match wins):
   - `.pi/agentic-team-charter.md` (relative to cwd)
   - `.cursor/agentic-team-charter.md`
   - `.claude/agentic-team-charter.md`
   - otherwise fall back to `~/.pi/agent/skills/agentic-team-protocol/CHARTER.md`
2. Read the charter with `read` or `cat`.
3. Compute a short version hash:
   ```bash
   VERSION=$(shasum -a 256 "${CHARTER_PATH}" | cut -d' ' -f1 | head -c 16)
   ```
4. Verify before recording:
   - The charter file exists.
   - If a project `agentic-team-config.yaml` exists, its active roles match the charter.
   - If the charter still contains placeholders such as `<PROJECT_NAME>`, report `no-proceed`.
5. Store a ratification record in Eden-memory:
   ```bash
   source "$HOME/.pi/agent/skills/agentic-team-protocol/eden.sh"
   RATER="${USER:-$(id -un)}"
   eden_remember archivist \
     "Charter ratified. Path: ${CHARTER_PATH}. Version: ${VERSION}. Rater: ${RATER}. Date: $(date -u +%Y-%m-%dT%H:%M:%SZ). Mechanism: /team-charter. Deferrals: none." \
     "{\"kind\":\"charter_ratification\",\"stage\":\"charter_ratification\",\"goal_id\":\"charter-ratification\",\"owner_role\":\"archivist\",\"version\":\"${VERSION}\"}"
   ```
6. Summarise for the user: charter path, version, ratification record ID (captured from `eden_remember` stdout), and proceed/no-proceed status. If critical guardrails are deferred, placeholders remain, or the charter is missing, report no-proceed.
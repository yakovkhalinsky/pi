---
description: Show active Agentic Team Protocol goals and current stages
argument-hint: "[optional goal_id or role filter]"
---

# /team-status

List active goals, current stage, owner role, and latest record IDs. Optionally filter by `goal_id` or role.

## Steps

1. Parse `$ARGUMENTS`. If it looks like a UUID or starts with `atp-`, treat it as a `goal_id` filter; otherwise treat it as a role filter (one of dispatcher, researcher, builder, runtime, verifier, archivist, router).
2. Call the `team_status` tool, passing `goal_id` and/or `role` from step 1. The tool reads Eden-memory, groups records by `goal_id`, finds the latest stage per goal, and renders a themed table with state pills (`active`, `blocked`, `pending_authorisation`, `continueable`, `closed`).
   - If the `team_status` tool is unavailable (e.g. the `agentic-team-protocol` extension is not loaded), fall back to the raw bash helper:
     ```bash
     source "$HOME/.pi/agent/skills/agentic-team-protocol/eden.sh"
     eden_search "agentic-team-protocol goal_record dispatch_instruction context_summary action_record verdict run_log hand_off_record pending_authorisation blocked cleanup_record archival_record" 100
     ```
     (Pass an agent_id filter via the third arg to `eden_search` if filtering by role.)
3. If no active goals are found, report that clearly and suggest starting a new task by spawning the Dispatcher subagent via the `subagent` tool.
4. Flag goals whose latest record is non-terminal and not `blocked`/`pending_authorisation` as `continueable` — candidates for `/team-continue`.
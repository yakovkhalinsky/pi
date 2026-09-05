---
description: Review and decide ATP goals waiting on human authorisation
argument-hint: "[goal_id] [approve|reject|defer] [note]"
---

# /team-approve

Surface ATP goals that owe a human decision, decide them with the user, and record the decision durably.

## Steps

1. Call the `team_status` tool. Collect goals whose state is `pending_authorisation` or `blocked` (the board's "⚠ Needs you" section).
2. If `$ARGUMENTS` contains a goal_id and a decision (e.g. `atp-snake-game-2026-09-03 approve`), skip the menu and go to step 4 for that goal.
3. Otherwise, for each pending goal: fetch its latest record via `team_lookup` and present a decision menu to the user — what is being asked, the prepared action, risk of acting, risk of waiting, and a recommended default. Wait for the user's choice. Do not decide unilaterally.
4. Call the `team_decide` tool with `{ goal_id, decision, note }`. It writes a durable `authorisation_record` and returns the record id.
5. Continue the goal per the decision:
   - `approve` → immediately spawn the `router` subagent for that goal_id; the owning role executes the prepared action.
   - `reject` → spawn the `router` subagent to route rework or closure.
   - `defer` → nothing to spawn; the goal stays on the Needs-you list.
6. Confirm the decision, the record id, and the new goal state to the user.

## Fallback

If the `team_decide` tool is unavailable (extension not loaded), store the decision with `bash` + `eden.sh`:

```bash
source "$HOME/.pi/agent/skills/agentic-team-protocol/eden.sh"
eden_remember dispatcher "Goal: <goal_id> | Stage: pending_authorisation | Owner: dispatcher
Human decision (<user id>): approved — <note>
Decided on pending record: <record_id>" '{"goal_id":"<goal_id>","stage":"pending_authorisation","owner_role":"dispatcher","record_type":"authorisation_record","status":"approved","protocol":"agentic-team-protocol"}'
```

Then spawn the `router` subagent as in step 5.
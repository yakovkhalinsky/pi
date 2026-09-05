---
description: Transfer ownership of an Agentic Team Protocol goal to another role or instance in a durable record
argument-hint: "goal_id: to_role [reason]"
---

# /team-handoff

Transfer ownership of an Agentic Team Protocol goal to another role or instance. The transfer is stored as a `hand_off_record` in Eden-memory so the receiving role can resume without relying on chat history.

## Steps

1. Parse `$ARGUMENTS` for `goal_id`, `to_role`, and optional `reason`. If any are missing, ask the user. `to_role` must be one of: dispatcher, researcher, builder, runtime, verifier, archivist, router.
2. Search Eden-memory for the latest records of the `goal_id` to capture:
   - current stage
   - current owner role and instance (if known)
   - latest `dispatch_instruction` (for success criteria, deadline, escalation trigger)
   - latest action/context/verdict record IDs
   ```bash
   source "$HOME/.pi/agent/skills/agentic-team-protocol/eden.sh"
   eden_search "${GOAL_ID}" 50
   ```
3. Determine the transferring role. If the hand-off is triggered by `/team-continue` or the Router, `FROM_ROLE` is `router`; otherwise it is the current owner role.
4. Write a `hand_off_record`:
   ```bash
   source "$HOME/.pi/agent/skills/agentic-team-protocol/eden.sh"
   THIS_ID="$(uuidgen | tr 'A-Z' 'a-z')"
   CONTENT="Goal: ${GOAL_ID} | Record ID: ${THIS_ID} | Stage: ${CURRENT_STAGE} | Owner: ${FROM_ROLE}
{\"record_type\":\"hand_off_record\",\"goal_id\":\"${GOAL_ID}\",\"stage\":\"${CURRENT_STAGE}\",\"from_role\":\"${FROM_ROLE}\",\"to_role\":\"${TO_ROLE}\",\"reason\":\"${REASON}\",\"input_record_ids\":[\"${LATEST_RECORD_ID}\"],\"output_record_ids\":[],\"success_criteria\":\"${SUCCESS_CRITERIA}\",\"deadline\":\"${DEADLINE}\",\"escalation_trigger\":\"${ESCALATION_TRIGGER}\"}"
   HAND_OFF_ID="$(eden_remember "${FROM_ROLE}" "$CONTENT" "{\"kind\":\"hand_off_record\",\"stage\":\"hand_off_or_closure\",\"goal_id\":\"${GOAL_ID}\",\"owner_role\":\"${FROM_ROLE}\"}")"
   ```
5. Spawn the receiving role as a pi subagent via the `subagent` tool with the hand-off payload, `HAND_OFF_ID`, and full goal context.

## Required fields

- `goal_id` — the goal being transferred.
- `to_role` — dispatcher | researcher | builder | runtime | verifier | archivist | router.
- `reason` — why ownership is changing.
- `success_criteria`, `deadline`, `escalation_trigger` — copied from the latest dispatch instruction or updated by the current owner.

## Anti-patterns

- Do not hand off implicitly through chat.
- Do not hand off without recording the latest input/output record IDs.
- Do not hand off to a role that lacks the tools or charter authority to continue.
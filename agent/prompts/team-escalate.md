---
description: Escalate an Agentic Team Protocol goal to the appropriate authority
argument-hint: "goal_id: reason and options"
---

# /team-escalate

Collect goal, options, consulted roles, recommended default, specific question/authority requested, and risk of waiting. Write a structured `escalation_record` to Eden-memory and route per the escalation levels.

## Steps

1. Extract `goal_id` and escalation reason from `$ARGUMENTS`. If empty or missing a `goal_id`, ask the user for the required details first.
2. Search Eden-memory for the latest records about the goal to include context:
   ```bash
   source "$HOME/.pi/agent/skills/agentic-team-protocol/eden.sh"
   eden_search "${GOAL_ID}" 50
   ```
3. Write an `escalation_record`:
   ```bash
   source "$HOME/.pi/agent/skills/agentic-team-protocol/eden.sh"
   THIS_ID="$(uuidgen | tr 'A-Z' 'a-z')"
   CONTENT="Goal: ${GOAL_ID} | Record ID: ${THIS_ID} | Stage: escalation | Owner: dispatcher
{\"record_type\":\"escalation_record\",\"goal_id\":\"${GOAL_ID}\",\"stage\":\"escalation\",\"owner_role\":\"dispatcher\",\"agent_id\":\"dispatcher\",\"reason\":\"${REASON}\",\"consulted_roles\":[\"dispatcher\"],\"recommended_default\":\"${RECOMMENDED}\",\"question\":\"${QUESTION}\",\"risk_of_waiting\":\"${RISK}\"}"
   RID="$(eden_remember dispatcher "$CONTENT" "{\"kind\":\"escalation_record\",\"stage\":\"escalation\",\"goal_id\":\"${GOAL_ID}\",\"owner_role\":\"dispatcher\"}")"
   ```
4. Route according to escalation levels and report the path to the user:
   1. Owning role → Dispatcher/Overseer within one status period.
   2. Dispatcher → Anchor Operations Chair same day.
   3. Chair → Founders' Circle within 48 hours for guardrail/risk issues.
   4. Final call by Founders' Circle or project owner.
5. Return the escalation record ID (`$RID`) and the assigned routing level.
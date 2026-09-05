---
description: Resume an unfinished Agentic Team Protocol goal from Eden-memory
argument-hint: "[goal_id]"
---

# /team-continue

Continue an Agentic Team Protocol goal by rehydrating its state from Eden-memory and dispatching the correct next role. This is the canonical automatic continuation path: after any role subagent writes its durable record and returns to the parent assistant, the parent invokes `/team-continue ${GOAL_ID}` (or spawns the `router` subagent) to route to the next role without asking the user. It also works for resuming goals across sessions. If no `goal_id` is given, list active continueable goals first.

## Steps

1. Parse `$ARGUMENTS`. If it looks like a UUID or contains a `-`, treat it as a `goal_id`. Otherwise list active goals via `/team-status` and ask the user to pick one.
2. Search Eden-memory for the latest records of that `goal_id`:
   ```bash
   source "$HOME/.pi/agent/skills/agentic-team-protocol/eden.sh"
   eden_search "${GOAL_ID}" 50
   ```
3. Identify the latest non-terminal record and any `blocked` or `pending_authorisation` record.
4. If the goal is `blocked` or `pending_authorisation`, report the blocker or approval question to the user and stop.
5. If the latest record is an `archival_record` with no newer action record, report that the goal is already closed.
6. Identify the latest durable record ID (`LATEST_RECORD_ID`) for the `goal_id` from the search results.
7. Write a continuation `run_log` that references the latest stage record as its input (not the `goal_id`):
   ```bash
   source "$HOME/.pi/agent/skills/agentic-team-protocol/eden.sh"
   THIS_ID="$(uuidgen | tr 'A-Z' 'a-z')"
   CONTENT="Goal: ${GOAL_ID} | Record ID: ${THIS_ID} | Stage: routing_and_assignment | Owner: router
{\"record_type\":\"run_log\",\"goal_id\":\"${GOAL_ID}\",\"stage\":\"routing_and_assignment\",\"owner_role\":\"router\",\"agent_id\":\"router\",\"status\":\"in_progress\",\"input_record_ids\":[\"${LATEST_RECORD_ID}\"],\"output_record_ids\":[],\"note\":\"Continued via /team-continue; router will write hand_off_record before parent spawns next role\"}"
   ROUTER_LOG_ID="$(eden_remember router "$CONTENT" "{\"kind\":\"run_log\",\"stage\":\"routing_and_assignment\",\"goal_id\":\"${GOAL_ID}\",\"owner_role\":\"router\"}")"
   ```
8. Spawn the `router` subagent via the pi `subagent` tool with the goal context, `LATEST_RECORD_ID`, and `ROUTER_LOG_ID`. The router reads Eden-memory, writes a durable `hand_off_record` with the full hand-off payload, and **returns** the routing decision (next role + record IDs). On pi the router does NOT spawn the next role — after the router returns, you (the parent assistant) spawn the chosen role via the `subagent` tool.
9. Do not ask the user "Shall I proceed?" between normal lifecycle transitions; only pause for `blocked`, `pending_authorisation`, or an `escalation_record`.

## Behaviour by goal state

| Latest record | Behaviour |
|---|---|
| `goal_record` | Route to Dispatcher to produce a `dispatch_instruction`. |
| `dispatch_instruction` | Route to the assigned role. |
| `context_summary` | Route to Builder or Runtime per the Dispatcher plan. |
| `action_record` | Route to Verifier. |
| `cleanup_record` | Route to Verifier to verify claimed releases. |
| `verdict` green | Route to Archivist for closure. |
| `verdict` red | Route to Dispatcher for rework assignment. |
| `verdict` blocked / `blocked` record | Report blocker and wait. |
| `pending_authorisation` | Ask the recorded approval question; resume if approved. |
| `hand_off_record` | Route to the receiving role. |
| `archival_record` (no newer action) | Report goal is closed. |
| `archival_record` + newer `action_record` | Treat as superseded; route to Verifier. |
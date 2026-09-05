---
description: Start or continue an Agentic Team Protocol goal via the Dispatcher/Router subagents
argument-hint: "[goal or request]"
---

# /team

Top-level entry point for the Agentic Team Protocol. Interpret the user's input and delegate to the right lifecycle path. Do not do role work yourself.

## Steps

1. Parse the argument `$ARGUMENTS`:
   - If empty or help-like (`help`, `?`, `status`) → run `/team-status` and ask what the user wants to do next.
   - If it looks like a `goal_id` (UUID-like, or contains a `-` and starts with `atp-`) → run `/team-continue $ARGUMENTS`.
   - Otherwise treat it as a new goal request.
2. For a new goal: spawn the `dispatcher` subagent via the pi `subagent` tool (single mode `{ agent: "dispatcher", task }`) with the full user request as the task. The Dispatcher records a `goal_record` and `dispatch_instruction` in Eden-memory and returns a `hand_off_record`.
3. After the Dispatcher returns, immediately continue the goal by spawning the `router` subagent (or invoking `/team-continue ${GOAL_ID}`) — do not ask "Shall I proceed?" unless the latest record is `blocked`, `pending_authorisation`, or an `escalation_record`.
4. To continue an existing goal, use `/team-continue` or the `router` subagent to rehydrate from Eden-memory.

## Behaviour

| Input | Action |
|---|---|
| (none) | Show status via `/team-status`, then ask for a goal. |
| `goal_id` / UUID-like | Resume via `/team-continue <goal_id>`. |
| Any other request | Spawn the `dispatcher` subagent to record and route a new goal. |

## Anti-patterns

- Do not perform role work directly in `/team`; hand off to the Dispatcher, Router, or a lifecycle command.
- Do not invent new goals without recording a `goal_record` in Eden-memory.
- Do not rely on conversation context when continuing; use `/team-continue` or the `router` subagent.
- Multi-step or non-trivial goals must not be planned outside Eden-memory; if a plan file is produced, record its path in a `context_summary` or `action_record`.

Reference: the full protocol lives in the `agentic-team-protocol` skill at `~/.pi/agent/skills/agentic-team-protocol/SKILL.md`.
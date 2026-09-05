# Agentic Team Protocol — pi install

Port of the [Agentic Team Protocol](https://yakov.khalinsky.com/agentic-team-protocol/) to the pi harness. Roles run as pi subagents; Eden-memory is the durable substrate, driven through its CLI (pi has no built-in MCP).

## What was installed

| Component | Location |
|---|---|
| Subagent extension | `pi-submarine` (`npm:pi-submarine`), registered in `~/.pi/agent/settings.json` |
| Role subagents | `~/.pi/agent/agents/{dispatcher,researcher,builder,runtime,verifier,archivist,router}.md` |
| Skill + helper + charter | `~/.pi/agent/skills/agentic-team-protocol/{SKILL.md,eden.sh,CHARTER.md}` |
| Slash commands (prompt templates) | `~/.pi/agent/prompts/{team,team-charter,team-status,team-escalate,team-continue,team-handoff}.md` |

Eden-memory CLI is already on PATH at `~/.local/bin/eden-memory`. The skill is generic — no org/user ids are hardcoded in the source: `EDEN_ORG_ID` and `EDEN_USER_ID` resolve from the environment or `~/.eden-memory/.env` (set once per machine, e.g. `EDEN_ORG_ID=my-org`); override per project with the env var. Sourcing `eden.sh` always checks for unset config: in an interactive terminal it walks the user through setup (`eden_setup`) and persists to `~/.eden-memory/.env` (mode 600); non-interactively it fails loudly with exact fix commands. `install.sh` runs the same check at the end.

## Live team UI & steering (always visible, no overlays)

While a team runs, a widget above the editor shows the goal board, live subagent rows (current tool, turns, elapsed, nested children — polled from the session's `.subagents/manifest.jsonl` and child transcripts), the needs-you list, and queued steers; the footer summarizes activity. Steer a running role with `/steer [goal-id] <role> <message>` or the `team_steer` tool: the steer is stored in Eden-memory and surfaces as `⚠ STEERING for <role>:` in the role's own transcript at its next `team_*` call. Hard interrupts stay stock: Esc aborts parent+child, then `subagent_resume` continues the child.

## Key pi adaptations vs the Cursor port

- **No MCP.** ATP talks to Eden-memory via the `eden-memory` CLI through `bash`. The shared helper `eden.sh` sources identity defaults and wraps `eden_remember`/`eden_recall`/`eden_search`/`eden_lookup`/`eden_health`. Every bash block that touches memory sources it.
- **Flat delegation.** On pi the `router` does NOT spawn the next role (the Cursor port did). Roles/subagents are isolated pi processes; to keep one level of nesting, the router returns a routing decision to the parent assistant, and the parent spawns the chosen role via the `subagent` tool.
- **Inherited model.** Agent frontmatter omits `model`, so each subagent inherits the dispatching session's active model.
- **Slash commands are prompt templates** (`~/.pi/agent/prompts/*.md`), not skill-with-`disable-model-invocation` as in Cursor. `/team`, `/team-charter`, `/team-status`, `/team-escalate`, `/team-continue`, `/team-handoff`.
- **Project opt-in** uses `.pi/agentic-team-charter.md` (falls back to `.cursor/` / `.claude/` paths).

## Use

Start a new pi session (so extensions/agents/skills/prompts load), then:

```
/team Add a runbook for X
/team-status
/team-continue <goal_id>
/team-escalate <goal_id>: <reason>
/team-handoff <goal_id>: <to_role> [reason]
```

The `agentic-team-protocol` skill loads on demand when ATP/role-team work is requested; the full lifecycle, record schema, and routing rules are in its `SKILL.md`.

## Verified

- All 7 agent frontmatters parse (valid `name`/`description`, non-empty body).
- Skill name/description satisfy the Agent Skills standard.
- All 6 prompt templates have descriptions and argument hints.
- End-to-end: parent pi spawned the `router` subagent via the `subagent` tool; it ran `echo SMOKE-OK` and returned `SMOKE OK`.
- Eden-memory CLI round-trip (`eden_remember` → `eden_search`) works and returns record UUIDs.
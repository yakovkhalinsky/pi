---
name: agentic-team-protocol
description: Run role-based agent teams on pi with a seven-stage task lifecycle and Eden-memory (via its CLI) as the durable substrate. Use when the user says /team, ATP, agentic team protocol, role-based team, or wants a non-trivial goal routed through Dispatcher, Researcher, Builder, Runtime, Verifier, Archivist, or Router subagents.
version: 1.1.1
tags: [agents, subagents, roles, eden-memory, protocol, team, pi]
---

# Agentic Team Protocol (pi harness)

This is the **pi** port of the Agentic Team Protocol (https://yakov.khalinsky.com/agentic-team-protocol/). The original was written for Cursor; this version uses pi primitives.

## pi harness mapping

- **Roles** are pi subagents in `~/.pi/agent/agents/` (`dispatcher`, `researcher`, `builder`, `runtime`, `verifier`, `archivist`, `router`). Spawn them with the pi `subagent` tool (single mode: `{ agent, task }`). Each role subagent inherits the dispatching session's active model (no per-role `model` override unless you add one).
- **Slash commands** are pi prompt templates in `~/.pi/agent/prompts/`: `/team`, `/team-charter`, `/team-status`, `/team-escalate`, `/team-continue`, `/team-handoff`.
- **Eden-memory** is the single source of truth for state, ownership, and auditability. pi has no built-in MCP, so ATP talks to Eden-memory through its CLI via bash. A shared helper lives at `~/.pi/agent/skills/agentic-team-protocol/eden.sh`; source it in any bash block that touches memory. Every source ALWAYS checks for identity config that isn't set: with a terminal it walks the user through interactive setup (`eden_setup`) and persists missing values to the config file; without one it fails loudly with exact fix commands — surface those to the user, never proceed with memory calls. It reads identity from the environment or `~/.eden-memory/.env` (`EDEN_ORG_ID`, `EDEN_USER_ID` — nothing org-specific is hardcoded in the source) and exports `EDEN_MEMORY_BIN`, `USER_ID`, `EDEN_ORG_ID`, `WORKSPACE_ID` and defines `eden_remember`, `eden_recall`, `eden_search`, `eden_lookup`, `eden_health`. `WORKSPACE_ID` defaults to the git directory basename. If the CLI is unavailable, install it (`curl -fsSL https://0d3sa.com/eden-memory/install.sh | sh`) or set `EDEN_MEMORY_BIN`.
- **TUI tools (preferred over raw bash):** the `agentic-team-protocol` extension (`~/.pi/agent/extensions/agentic-team-protocol/index.ts`) registers `team_status`, `team_recall`, `team_remember`, `team_lookup`, and `team_decide` tools that wrap the same Eden-memory CLI and render themed TUI output (state-pill tables, scored match lists, confirmation/record cards, decision cards). Role subagents and the parent assistant should call these tools instead of `bash` + `eden.sh` for ATP memory I/O so the tool-call output is rich and auditable. The `/team-board` command renders a full-width bordered goal board; `/team-approve` is the human-decision flow for `pending_authorisation`/`blocked` goals. If the extension is not loaded, fall back to `bash` + `eden.sh`.
- **Project opt-in** uses `.pi/agentic-team-charter.md` (and optionally `.pi/agentic-team-config.yaml`). Falls back to `.cursor/` or `.claude/` charter paths if a project was opted in for another harness.
- **Flat delegation:** on pi the router does NOT spawn the next role. Roles return a routing decision to the parent assistant, and the parent assistant spawns the chosen role via the `subagent` tool. This keeps a single level of subagent nesting.
- After a role subagent returns, immediately spawn `router` (or invoke `/team-continue ${GOAL_ID}`). Do not ask "Shall I proceed?" except when the latest record is `blocked`, `pending_authorisation`, or an `escalation_record`.

A role-based agent team protocol implemented as pi primitives (subagent extension, agents, prompt-template commands, a skill) with Eden-memory as the single source of truth for state, ownership, and auditability.

## Setup (already installed)

- Subagent extension: `pi-submarine` (`npm:pi-submarine`, registered in `~/.pi/agent/settings.json`). Registers `subagent` (`{ agent?, task, model?, thinkingLevel?, context?, cwd? }`), `subagent_resume`, and `subagent_list`. Fresh child sessions run under the parent session's `.subagents/` directory with a tail-able `.jsonl.subagents.md` activity log.
- Role agents: `~/.pi/agent/agents/{dispatcher,researcher,builder,runtime,verifier,archivist,router}.md`.
- Skill + helper + charter: `~/.pi/agent/skills/agentic-team-protocol/{SKILL.md,eden.sh,CHARTER.md}`.
- Commands: `~/.pi/agent/prompts/{team,team-charter,team-status,team-escalate,team-continue,team-handoff}.md`.
- Eden-memory CLI on PATH (verified). Identity is config-driven, never hardcoded in the source: `EDEN_ORG_ID` (and `EDEN_USER_ID`) resolve from the environment or `~/.eden-memory/.env`; override per project with the env var. Sourcing `eden.sh` always checks for unset config: in an interactive terminal it walks the user through setup and persists to `~/.eden-memory/.env`; in agent bash blocks (no TTY) it fails loudly with the exact fix — surface it to the user and stop rather than proceeding. `install.sh` runs the same check at the end of setup.

Restart pi (new session) so the subagent extension, agents, skills, and prompt templates load.

## Live team UI (plain sight — no commands needed)

- **Goal-board widget.** While a team runs, a widget above the editor always shows: the goal board (state/stage/owner per goal; while a hand-off is in flight the owner column shows the incoming role as `→ role` — roles write their stage record at the END of their work, so the handing-off role would otherwise own the board until the next role finishes), live subagent rows (`● builder · → edit runner.ts · 14 turns · 6m`, nested children indented), the needs-you list, and any queued steers. It updates from subagent run events plus a 2s poller over the session's `.subagents/manifest.jsonl` and child session transcripts; the footer status line summarizes `ATP <n> active · <m> pending`.
- **Steering a running role.** `/steer [goal-id] <role> <message>` (user) or the `team_steer` tool (orchestrator) queues a `steer_request` record in Eden-memory. The role consumes it at its next `team_*` call — the message appears as `⚠ STEERING for <role>:` in the role's own transcript. `steer_request` records are control messages and never affect goal state.
- **Hard interrupt.** Esc aborts the parent turn and the child with it; continue the child with `subagent_resume`. Prefer `team_steer` for mid-run redirection.


## Core idea

Every goal passes through a seven-stage lifecycle. Each stage has an owner role, exit criteria, and a durable record in Eden-memory. Roles are specialised pi subagents; the Dispatcher decides who does what; the Verifier gate is mandatory before closure.

## When to use

Use this protocol when a task is non-trivial, risky, multi-step, or needs to be observable across sessions. For trivial one-line fixes, direct action is fine.

## Roles

| Role | Obligation | Subagent |
|------|------------|----------|
| Dispatcher | Decides who does what | `dispatcher` |
| Researcher | Gathers context before decisions | `researcher` |
| Builder | Produces durable, reviewable artefacts | `builder` |
| Runtime | Operates live systems safely | `runtime` |
| Verifier | Validates work before acceptance | `verifier` |
| Archivist | Maintains durable, searchable fleet memory | `archivist` |
| Router | Rehydrates a goal and decides the next role | `router` |

## Seven-stage task lifecycle

1. **Goal receipt** — Dispatcher records the request, requester, constraints, and package type.
2. **Routing and assignment** — Dispatcher assigns target role/package, owner, deadline, success criteria, confidence/escalation trigger.
3. **Context gathering** — Researcher (or assigned role) records what is known, evaluates options, chooses a path, and captures any written plan. Planning belongs in the durable record.
4. **Action** — Builder or Runtime executes the plan and records what was done, rollback options, and state changes. A role may park the goal as `pending_authorisation` if it needs explicit user approval. If it created temporary resources during a non-trivial turn, it may emit a `cleanup_record` before handing off to Verifier.
5. **Verification** — Verifier inspects outcome against success criteria and writes a verdict (`green`, `red`, or `blocked`).
6. **Recording and archival** — Archivist ensures final outcome, decision trail, and skill/runbook updates are stored.
7. **Hand-off or closure** — Archivist confirms records are complete and ownership is transferred if handing off. A new action record after closure supersedes the closure and returns the goal to Action.

**Closure disposition rule (F4-spec):** a goal may not close while any `pending_authorisation` or `blocked` record for that `goal_id` is unresolved. Closure requires a recorded disposition for every such record: an `authorisation_record` (approve/reject/defer via `team_decide`/`/team-approve`), or an explicit archival note that the pending item deliberately survives closure together with its unblock condition. `team_status` surfaces pending items even on closed goals (this surfacing is owned by the parallel tooling goal `atp-tooling-hardening-2026-09-04`), so closures with open pending items remain visible and auditable.

### Resumable sub-states

- `blocked` — waiting on an external dependency or authority. The owning role records the unblock condition. The router checks it on every `/team-continue`.
- `pending_authorisation` — waiting on explicit user approval for a specific high-risk action outside routine charter authority. The exact question and prepared action are recorded so a new session can resume. Routine commit/push after a green Verifier verdict is not a `pending_authorisation` step. The user decides via `/team-approve <goal_id> approve|reject|defer [note]` (or the `team_decide` tool); the decision is stored as a durable `authorisation_record` and the parent then spawns the router to continue (approve → owning role executes; reject → router rework/closure; defer → stays pending).
- `cleanup_record` — optional cleanup stage after a non-trivial action. The role documents what temporary resources were released; the router routes the goal to Verifier so the claimed releases can be confirmed.

### Cleanup-record discipline (F1: cleanup scope is per-goal, never per-scope)

A forget is a deletion of durable memory. Scope mistakes here are the most destructive failure ATP has observed (one archivist's scope-wide cleanup deleted 7 canonical records of a *parallel* team and mis-rationalized them as its own retry artifacts). Therefore:

1. A `cleanup_record` must enumerate the exact record ids it owns — the goal's own `output_record_ids` produced by this role/instance.
2. Forgetting any record NOT in that owned list is prohibited, even if it looks like a retry artifact, probe, or duplicate.
3. Every forget must be preceded by a per-id `eden_lookup`/`team_lookup` verification of that record's `goal_id`, `owner_role`, and `agent_id`. Never enumerate cleanup candidates by a shared scope such as `agent_id` or workspace — parallel teams share those scopes.
4. The `cleanup_record` must list every forgotten id together with its verification evidence (the lookup result showing the id was owned by this goal).
5. When in doubt, do not forget — record the item as deliberately retained in the `cleanup_record` instead.

## Routing rules and dispatcher defaults

- Every new goal starts with Dispatcher.
- The dispatcher writes the `goal_record` (stage `goal_receipt`) as its FIRST durable action on a new goal — before context recall or planning. The goal board cannot display a goal until that record exists, so delaying it leaves the board agent-rows-only at the start of a run.
- Package types:
  - `research` → Researcher
  - `build` → Builder
  - `run` → Runtime
  - `verify` → Verifier
  - `archive` → Archivist
- Low confidence, missing authority, or tight deadline → escalate via `/team-escalate`.
- Builder and Runtime must not start without sufficient context and a visible plan (either in `context_summary` or `action_record`); request Researcher support if needed.
- When a session ends or a role is interrupted, the next session uses `/team-continue` (or the router subagent) to rehydrate the goal from Eden-memory and dispatch the correct next role.
- A `blocked` or `pending_authorisation` goal remains active until the recorded unblock/approval condition is satisfied; the router re-checks it on continuation.

## Automatic continuation within a session

After any role subagent writes its durable stage record and `hand_off_record` and returns to the parent assistant, the parent assistant must immediately continue the goal without asking the user. The parent must spawn the `router` subagent (or invoke `/team-continue ${GOAL_ID}`) so the router can read the latest Eden-memory records, determine the next required stage and role, and return the routing decision; the parent then spawns the chosen role.

The parent assistant must not ask "Shall I proceed?" or otherwise wait for user confirmation between normal lifecycle transitions.

Exceptions — pause and surface the situation to the user instead of auto-continuing only when the latest durable record indicates:

- `blocked` — waiting on an external dependency or authority.
- `pending_authorisation` — waiting on explicit user approval for a specific action.
- An explicit escalation is required (e.g., low confidence, missed deadline, or charter conflict).

### Parent assistant continuation checklist

1. Read the latest Eden-memory record for the `goal_id`.
2. If it is `blocked`, `pending_authorisation`, or an `escalation_record`, stop and surface the situation to the user. Offer `/team-approve` (or the `team_decide` tool) for the decision; do not decide unilaterally.
3. Otherwise, immediately spawn the `router` subagent or invoke `/team-continue ${GOAL_ID}`.
4. Do not ask "Shall I proceed?" between normal lifecycle transitions.

For cross-session or cross-role transfers, the transferring role (or the Router when continuing) must also write a `hand_off_record`.

## Hand-off format

Every lifecycle transition must leave a durable `hand_off_record` (or an equivalent action/verdict/archival record that embeds the hand-off format) in Eden-memory before ownership changes. Chat history is not a hand-off.

Every hand-off must include:

- `goal_id`
- Current stage
- Owner role and instance
- Input record IDs (the latest durable stage records, not the `goal_id` itself)
- Output record IDs (the new hand-off/run_log/action record, or the receiving role's expected record)
- Next role
- Reason for the transfer
- Success criteria and deadline
- Escalation trigger (if any)

### Router obligation

When the Router decides the next role, it must first write a durable hand-off record (a `hand_off_record` or a continuation `run_log` with the full hand-off payload). This record is the activation signal that lets the receiving role recall the goal without depending on conversation context. On pi the router then returns the decision to the parent, which spawns the next role. If the spawned role fails to produce its expected downstream record, the Router (on a later `/team-continue`) writes a recovery record and reports the missing hand-off to the user.

## Eden-memory record schema

Store records with metadata so they can be recalled, linked, and audited. Every durable record must also begin its `content` with a searchable identity line because `eden_recall` and `eden_search` inspect `content`, not metadata:

```text
Goal: <goal_id> | Record ID: <this_record_id> | Stage: <stage> | Owner: <owner_role>
```

The identity line embeds both `goal_id` and the record's own UUID in searchable text. If the storage tool returns the record ID after creation, update the content to insert the actual UUID.

```json
{
  "goal_id": "<uuid>",
  "stage": "goal_receipt | routing_and_assignment | context_gathering | action | verification | recording_and_archival | hand_off_or_closure | blocked | pending_authorisation | cleanup",
  "owner_role": "dispatcher | researcher | builder | runtime | verifier | archivist | router",
  "owner_instance": "<optional instance id>",
  "input_record_ids": ["<id>"],
  "output_record_ids": ["<id>"],
  "recalled_memory_ids": ["<id>"],
  "verdict_id": "<id when applicable>",
  "status": "<in_progress | completed | blocked | pending_authorisation>",
  "plan_file_path": "<absolute path when a plan file exists; optional but strongly recommended>"
}
```

Every durable record that relies on recalled Eden-memory context must include `recalled_memory_ids`: the IDs of the memories that shaped the record. This applies to `context_summary`, `action_record`, `verdict`, and any other record written after an `eden_recall` or `eden_search` call.

Use the clean role name as `agent_id` for all ATP role records (e.g., `dispatcher`, `researcher`, `builder`, `runtime`, `verifier`, `archivist`, `router`).

Required record types:

- `goal_record` — initial request and constraints.
- `dispatch_instruction` — routing decision from Dispatcher.
- `context_summary` — findings from Researcher.
- `action_record` — what Builder or Runtime did.
- `verdict` — green/red/blocked from Verifier with evidence.
- `escalation_record` — escalation request and routing.
- `archival_record` — final outcome and links.
- `run_log` — coarse-grained event written by a role at the start/end of each turn; used by the router to detect stale or interrupted work.
- `cleanup_record` — release and evidence for temporary resources. Not a terminal record; the goal still requires a `green` verdict before closure.
- `hand_off_record` — explicit ownership transfer between roles or instances, including input/output IDs, success criteria, and deadline.
- `authorisation_record` — durable human decision (approve/reject/defer) on a `pending_authorisation` or `blocked` item, written via the `team_decide` tool or `/team-approve`; references the pending record in `input_record_ids`.

**Record-type discipline (F5a):** a parked, prepared high-risk action (the role is ready to execute it but awaits explicit user authorisation) is recorded with `stage: pending_authorisation` and `record_type: pending_authorisation`, referencing the owning role — NOT as an `action_record`. An `action_record` asserts work that was actually done; using it to park a pending action misrepresents goal state and misroutes the goal (this drift was caught in the 2026-09-03 audit). Conversely, record an `action_record` only for work actually performed.

## Memory-first rules

- Immediately after receiving a task, call `eden_recall` with the task summary.
- Before any decision that touches user preferences, coding style, security, tooling, or project conventions, call `eden_recall` first.
- When reviewing `eden_recall` results, only treat a memory as relevant if its score is ≥ 0.45. For low scores, call `eden_search` or ask the user.
- After corrections, working solutions, or settled conventions, call `eden_remember`.
- At the end of every task, batch 3–5 durable takeaways into `eden_remember` calls.
- Do not remember secrets, tokens, raw command output, ephemeral reasoning, or unvalidated guesses.
- Source `~/.pi/agent/skills/agentic-team-protocol/eden.sh` in any bash block that touches memory.

## Anti-patterns to avoid

- **Role collapse** — use the correct subagent for each stage.
- **Missing Dispatcher** — every new goal starts with Dispatcher.
- **Skipped Researcher** — non-trivial goals need explicit context gathering.
- **Runtime without rollback** — Runtime must produce a rollback plan.
- **Verifiability gap** — Verifier gate is mandatory before closure.
- **Archivist as secretary** — Archivist owns linking and skill/runbook updates.
- **Memory blindness** — Eden-memory is the single source of truth; do not rely on conversation context.
- **Dropped interrupted work (F6a)** — every role turn ends with a `run_log` (or a final stage record) so `/team-continue` can resume; a `run_log` left dangling `in_progress` from an interrupted turn must be closed or superseded at the start of the next turn or continuation.
- **Scope-wide cleanup forgets (F1)** — never base a record cleanup on a shared scope (`agent_id`, workspace). A `cleanup_record` may only forget ids it explicitly owns (its own `output_record_ids`), verified per-id beforehand; see Cleanup-record discipline.
- **Untracked global-file edits (F5b)** — any edit a role makes to global protocol files (`SKILL.md`, `agents/*.md`, `eden.sh`, `extensions/*`, or other files under `~/.pi/agent/`) during a goal must be listed in that goal's `action_record`/`archival_record` with file paths and the reason for the edit. Live-editing shared protocol files without a durable record hides side effects from the Verifier and the audit trail.
- **Implicit hand-offs** — transfer ownership through a promoted `hand_off_record`, not chat history. The Router must write this record before returning its decision.
- **Stale closures** — a new action record after closure supersedes it; do not assume an old `archival_record` is the final word.
- **Ghost planning** — capturing a plan only in a local file or chat history without referencing it from an Eden-memory record. Any plan file must be referenced from `context_summary` or `action_record`.
- **Default-branch drift** — committing non-trivial work directly to `master`/`main` instead of using a feature branch.
- **Fast-forward erasure** — merging feature branches with fast-forward so the branch topology and parent SHAs are lost.
- **Force-push to default branch** — rewriting public default-branch history, which breaks the durable record chain.

## Scope resolution rules

1. Project-local charter (`<project>/.pi/agentic-team-charter.md`) overrides global charter.
2. Project-local agent definitions (`.pi/agents/*.md`) automatically override global agents with the same filename stem (pi-submarine discovery).
3. Project-local skill overrides global skill.
4. If a project has no `agentic-team-config.yaml`, the global skill is used and the global charter is ignored unless explicitly referenced.

## Branch discipline

- Non-trivial work must happen on a feature branch checked out from the project default branch. Trivial one-line fixes may be committed directly to the default branch.
- Merges into the default branch must be non-fast-forward merge commits that preserve both parent SHAs.
- Runtime is the only role that may create merge commits and push to the default branch, and only after a green Verifier verdict.
- After a successful non-fast-forward merge into the default branch and push to origin, Runtime must delete the local feature branch (`git branch -d <branch>`). If authorized and the branch is not protected, Runtime must also delete the remote branch (`git push origin --delete <branch>`). Runtime records the deleted branch names, post-merge default-branch SHA, and any skip reason in the action record.
- Protected/long-lived branches must never be deleted (default branch, `release/*`, `hotfix/*`, etc.).
- In headless workflows, skip local deletion if the working copy is not on the feature branch and record `headless_skip_local: true`.
- Never force-push the default branch.

## Slash commands

- `/team-charter` — read the project's `agentic-team-charter.md`, store a ratification record, and report whether the team may proceed.
- `/team-status` — list active goals, current stage, owner role, latest record IDs, and continueable/blocked state.
- `/team-escalate` — collect goal, options, consulted roles, recommended default, specific question/authority requested, and risk of waiting; write an `escalation_record`.
- `/team-continue` — resume an unfinished goal from Eden-memory by rehydrating its state and dispatching the next required role.
- `/team-handoff` — transfer ownership of a goal to another role or instance in a durable `hand_off_record`.
- `/team` — top-level entry: start a new goal (spawn `dispatcher`), continue an existing goal by `goal_id`, or show status.

## Using the subagents

Spawn a role subagent with the pi `subagent` tool (single mode): pass the role `agent` name and a `task` containing the goal context and `goal_id`. Each role subagent starts by recalling the latest `goal_record` for its assigned `goal_id`, then acts according to its contract, and finally writes a durable record to Eden-memory before handing off.

When a role subagent returns after writing its durable record and `hand_off_record`, the parent assistant must immediately continue the goal by spawning the `router` subagent (or invoking `/team-continue ${GOAL_ID}`). The parent must not ask "Shall I proceed?" between normal lifecycle transitions.

For continuation, use the `router` subagent (or `/team-continue`) instead of manually picking a role. The router reads the latest Eden records for a `goal_id`, determines the required next stage and role using the lifecycle rules below, and returns the decision; the parent then spawns that role with full context.

### Router lifecycle rules

Given the latest non-terminal record for a `goal_id`:

| Latest record | Next stage | Next role |
|---|---|---|
| `goal_record` | routing_and_assignment | Dispatcher |
| `dispatch_instruction` | context_gathering or action | Researcher (if package is research) or assigned role |
| `context_summary` | action | Builder or Runtime per Dispatcher plan |
| `action_record` | verification | Verifier |
| `cleanup_record` | verification | Verifier |
| `verdict` status `red` | routing_and_assignment (rework) | Dispatcher |
| `verdict` status `blocked` | blocked | owning role re-checks unblock condition |
| `verdict` status `green` | recording_and_archival | Archivist |
| `hand_off_record` | action / verification per hand-off | receiving role |
| `pending_authorisation` | action | Builder/Runtime after user approval |
| `authorisation_record` (approved) | action | owning role executes the approved prepared action |
| `authorisation_record` (rejected) | routing_and_assignment | Dispatcher (rework or closure) |
| `authorisation_record` (deferred) | pending_authorisation | none — goal stays awaiting the human |
| `archival_record` | hand_off_or_closure | none — goal is closed; report only |

If a new `action_record` is stored after an `archival_record` for the same `goal_id`, the archival record is superseded and the goal returns to Action. Before closing on `archival_record` (router or archivist), apply the closure disposition rule: every unresolved `pending_authorisation`/`blocked` record for the `goal_id` needs a recorded disposition first — an `authorisation_record`, or an explicit archival note that the item deliberately survives closure with its unblock condition (see the Seven-stage lifecycle rules; `team_status` surfaces pending items on closed goals — tooling side owned by `atp-tooling-hardening-2026-09-04`).

## Known quirks & operational notes (observed 2026-09-03, eden-memory CLI v0.3.94)

- **Project-level `.env` hijacks the CLI DB.** The CLI resolves `EDEN_DB_PATH` from a project-level `.env` in cwd before `~/.eden-memory/default.db`, so a leftover `eden-memory setup` fixture (e.g. `EDEN_DB_PATH=/tmp/test-home-…`) silently redirects every role's writes to a throwaway DB while the board read the default path — the goal board went agents-only (2026-09-06, workspace `eden-memory`). The extension now probes the CLI's effective `db_path` via `health` once per session and pins `--db` on every CLI call, so board reads and role writes land in the same file by construction; `team_status` surfaces a `· db ~/…` hint when the resolved DB is not the default. If a repo still carries a stale setup fixture, remove it (observed: `~/git/eden-memory/.env`, generated by `setup claude`, pointing at `/tmp/test-home-70981`; the 13 rebrand-run records it captured were migrated back into the default DB).
- **Record ids are server-assigned (F6c).** `remember --id` is ignored, so identity-line `Record ID:` values (uuidgen-declared pre-write) never match the stored id. Align the identity line to the stored id as a numbered procedure after every `remember`:
  1. Store the record with a placeholder identity line, e.g. `Record ID: pending`.
  2. Capture the CLI-assigned id printed by `eden_remember`/`team_remember` — the stored id is canonical.
  3. Edit the record via the CLI to replace the placeholder with the stored id:
     `$EDEN_MEMORY_BIN edit --id <assigned_id> --user-id "$USER_ID" --org-id "$EDEN_ORG_ID" --workspace-id "$WORKSPACE_ID" --content "<identity line carrying the assigned id>" --metadata <same metadata as the original write>`
  4. Cite **stored** ids in `input_record_ids`/`recalled_memory_ids`; carry the declared id only as an extra metadata field (e.g. `declared_record_id`).

  (`team_remember`/the extension write the aligned identity line automatically; the numbered CLI edit applies to raw `eden.sh`/`eden-memory` usage.)
- **`search` requires `--agent-id`.** The `eden.sh` wrapper only passes it when given; pass the role name explicitly or search fails (`--agent-id, --user-id, and --keywords are required`). The wrapper's default `--agent-id` handling is being fixed in `eden.sh` by the parallel tooling goal `atp-tooling-hardening-2026-09-04`; do not patch the wrapper from a spec goal (F6d).
- **`lookup` is user/org/workspace-scoped.** The same id in another workspace returns `found: false` — first check which workspace a record actually lives in before concluding it is missing.
- **Pin the workspace explicitly.** `WORKSPACE_ID` defaults to the cwd basename; subagents spawned from a different cwd (or a parent whose workspace differs from the repo basename) silently read/write a different memory scope. Pass the memory workspace in every subagent task prompt and export it before any memory call.
- **Empty id = failed write.** The wrapper hides CLI stderr (`2>/dev/null`); transient SQLITE_BUSY/embedding failures return an empty id. Check every captured id is non-empty and retry before proceeding. (`forget --id` exists for probe/temp record cleanup; do not invoke `eden-memory` bare — it starts an MCP stdio server.)
- **Parallel teams on one repo:** verification must be read-only and branch-aware — test `git show <branch>:<path>` output in a temp dir, never `git checkout`; leave the shared working copy on the branch it was found on; prove scope with `git diff --name-status main...<feature>`.
- **Fully specified build goals** may skip the Researcher pass, but the justification must be written into the `dispatch_instruction` record.
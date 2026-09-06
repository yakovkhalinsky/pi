# ATP test suite — scope

Scoping for automated tests over the Agentic Team Protocol stack: **protocol
adherence**, **memory hygiene**, and **UI display & interaction**.

Status: scope approved. **All milestones landed — M1–M5** (157/157 green ~7s offline;
+3 e2e green with `ATP_E2E=1`): `tests/atp/` — harness + smoke (M1),
protocol-state / protocol-io / dbpinning-{probe,hijack,override} / scoping-workspace /
sql-scoping (M2), ui-board / ui-cards / ui-text (M3), eden-sh / tool-surface /
genericity (M4), widget-poller / steer-ux / commands-board / e2e-real-cli (M5).

Runner: `node --test tests/atp/*.test.ts` (Node ≥23 native TS type-stripping;
repo-root `node_modules/` symlinks via `tests/setup.sh`). T3 real-CLI e2e is
opt-in: `ATP_E2E=1 node --test tests/atp/e2e-real-cli.test.ts` (scratch DBs
under /tmp via EDEN_DB_PATH; identity from the machine config; no identifiers
hardcoded or printed).

---

## 0. Subject under test

| Unit | Path | Size |
|------|------|------|
| ATP extension (tools, commands, widget, poller) | `~/.pi/agent/extensions/agentic-team-protocol/index.ts` (mirrored at `agent/extensions/…`) | 2,340 lines |
| Eden-memory CLI wrapper | `~/.pi/agent/skills/agentic-team-protocol/eden.sh` (mirrored at `agent/skills/…`) | 278 lines |
| Role agents / prompt templates | `~/.pi/agent/{agents,prompts}/` | 7 + 7 files (protocol *text* — out of automated scope) |
| Eden-memory CLI | `~/.local/bin/eden-memory` (v0.3.x) | external; exercised via stub + real-CLI tiers |

Verified facts this scope relies on:

- Subdirectory extensions only auto-load `index.ts` (`extensions.md` discovery
  table) — colocated `*.test.ts` files are never loaded by pi, but tests still
  live in the repo (`tests/`), never in `~/.pi/agent/extensions/`.
- `Container.render(width): string[]` — pi-tui output is assertable as strings.
- The real `eden-memory` CLI works fully offline against a scratch DB
  (`--db /tmp/…`), so a genuine end-to-end tier is viable.
- `index.ts` has no enums/namespaces/parameter-properties → Node ≥23 native
  type-stripping runs it under `node --test` without a build step.

---

## 1. Test architecture

### Location & runner

- Tests live in **`tests/atp/`** in this repo (the canonical dev home of the
  mirrored files). `install.sh` must NOT copy `tests/` into `~/.pi/agent/`.
- Runner: **`node --test`** with Node's native TS type-stripping (Node 26 on
  this machine). No new dependencies; no test framework to pin.
- Module resolution: `tests/node_modules/@earendil-works/{pi-coding-agent}`
  symlinked to the installed pi package (which carries `pi-tui`, `typebox` in
  its own `node_modules`). Created by `tests/setup.sh`; `tests/node_modules/`
  is gitignored. Also re-create in install.sh? No — tests are dev-time only;
  `tests/setup.sh` is documented in this file until a README row lands.

### Seams (three, in order of preference)

1. **Pure-function unit seam** — `index.ts`'s ~25 module-private pure helpers
   (`classifyState`, `summarizeGoals`, `findStrandedPending`, `parseRecord`,
   `stripIdentity`, `tailJsonl`, …) get a test-only export block at the bottom
   of `index.ts` (add `export` keywords / an `export { … }` statement — zero
   behavior change). NOTE: editing the live global extension file is exactly
   the F5b "untracked global-file edit" anti-pattern — when done inside a
   goal, list it in that goal's `action_record`.
2. **Tool-level seam** — a mock `pi` object that captures
   `registerTool`/`registerCommand`; call the default export with it, then
   drive `tools.team_status.execute(toolCallId, params, signal, onUpdate, ctx)`
   directly with a fake `ctx` (`{ cwd }`). The CLI is controlled via env:
   - **Stub tier (T2):** `EDEN_MEMORY_BIN` → fixture script that logs argv to
     a file and emits canned JSON (success / empty id / fail-twice-then-ok /
     health with a chosen `db_path`).
   - **Real tier (T3, opt-in `ATP_E2E=1`):** real `eden-memory` with
     `EDEN_MEMORY_DB=/tmp/atp-test-<pid>.db`, org/user from the machine
     config env (never hardcoded — fixtures use `test-org`/`test-user` in
     stubs).
3. **Rendering seam** — mock `Theme` (passthrough `fg`/`bold` that record the
   color tag), then assert on `Container.render(width)` string arrays after
   stripping ANSI for content matching.

### Tiers

| Tier | What | When |
|------|------|------|
| T1 unit | pure functions over fixture records | always, ms-fast |
| T2 stub-integration | tools + renderers vs fixture CLI binary | always |
| T3 real-e2e | tools vs real eden-memory + scratch /tmp DB; workspace-isolation & DB-pinning proofs | opt-in (`ATP_E2E=1`) |
| T4 scenario (future, out of scope now) | pi-SDK scripted sessions spawning role subagents against a scratch DB; asserts the seven-stage record trail | later |

Bash tests for `eden.sh` run as plain `bash tests/atp/eden.sh.bats`-style
scripts under `node --test` child processes (or a `tests/atp/eden_sh.test.mjs`
that shells out); `sleep` inside `eden_remember` is intercepted with a bash
`sleep()` function so retry tests stay fast.

---

## 2. Scope A — protocol adherence

The extension's `classifyState` is documented as mirroring the SKILL.md router
lifecycle table; these tests pin that contract so SKILL.md and code cannot
drift silently.

### A1. Lifecycle state machine — `classifyState` (T1)

| ID | Case |
|----|------|
| A1-1 | status containing `blocked` → `blocked` (regardless of type/stage) |
| A1-2 | status containing `pending` or type `pending_authorisation` → `pending_authorisation` |
| A1-3 | `authorisation_record` + approve status → `continueable` (control returns to router) |
| A1-4 | `authorisation_record` + defer status → `pending_authorisation` (goal visibly awaits human) |
| A1-5 | `archival_record` → `closed` |
| A1-6 | `hand_off_record` owned by archivist **with** prior archival → `closed` |
| A1-7 | `hand_off_record` owned by archivist **without** archival → `continueable` (mid-flight hand-off, not closure) |
| A1-8 | `hand_off_record` by any other role → `continueable` |
| A1-9 | `verdict` green → `active` (→ archivist) |
| A1-10 | `verdict` red → `continueable` (→ rework) |
| A1-11 | `verdict` with blocked status → `blocked` |
| A1-12 | stage `recording_and_archival` (non-terminal record) → `active` |
| A1-13 | unknown record falls through → `continueable` (never silently closed) |

### A2. Goal summarization — `summarizeGoals` (T1)

| ID | Case |
|----|------|
| A2-1 | latest record per goal chosen by `createdAt` desc |
| A2-2 | equal-timestamp tie-break deterministic (insertion order preserved, newest inserted wins) |
| A2-3 | `steer_request` records excluded from lifecycle state entirely |
| A2-4 | `goalId` filter keeps only that goal's records |
| A2-5 | `role` filter matches `agentId` **or** `owner` |
| A2-6 | in-flight hand-off: newest `hand_off_record` to a known ATP role with no later record from that role → `nextOwner` set (board shows `→ role`) |
| A2-7 | hand-off target already produced a later record → no `nextOwner` |
| A2-8 | hand-off `next_role` == hand-off owner → no `nextOwner` |
| A2-9 | junk `next_role` (e.g. `closure`) not in ATP_ROLES → no `nextOwner` |
| A2-10 | closed goals never get `nextOwner` (archivist closure hand-off is not an activation) |
| A2-11 | stageLabel: closed → `Closure`; stage `hand_off_or_closure` → `Hand-off`; else humanized stage |
| A2-12 | goal title from newest `goal_record` body; missing/empty title → `prettifyGoalId` fallback |
| A2-13 | summaries sorted by latest-record `createdAt` desc; `recordCount` correct |

### A3. Pending-after-closure surfacing (F4) — `isPendingItem`, `latestPendingForGoal`, `findStrandedPending` (T1)

| ID | Case |
|----|------|
| A3-1 | open pending/blocked record on a **closed** goal is surfaced as stranded with its body as the question |
| A3-2 | pending record followed by a later `authorisation_record` → NOT stranded (decision resolves it) |
| A3-3 | `authorisation_record` itself is never an open item |
| A3-4 | only the latest pending item per goal is reported |
| A3-5 | items on non-closed goals are not duplicated into the stranded list (they surface via goal state) |
| A3-6 | stranded list sorted by goalId |

### A4. Record schema & identity lines (T1)

| ID | Case |
|----|------|
| A4-1 | identity line `Goal: X \| Record ID: Y \| Stage: S \| Owner: R` parsed into fields; metadata fallback for older records |
| A4-2 | `parseMetadata` tolerates null/invalid JSON |
| A4-3 | `stripIdentity` removes the identity line from the displayed body but keeps the rest |
| A4-4 | `unwrapJsonBlob` extracts content from JSON-string blobs |
| A4-5 | `humanizeBody` renders known record shapes readably |
| A4-6 | `extractGoalTitle` variants (title line, first line, absent) |

### A5. Record-type discipline (F5a) (T1)

| ID | Case |
|----|------|
| A5-1 | parked high-risk action recorded as `record_type: pending_authorisation` (even with stage `action`) classifies `pending_authorisation`, never `active` |
| A5-2 | `action_record` (status completed) → `continueable` → routes to verification; never mistaken for parked action |

### A6. Identity-line contract on write — `team_remember` (T2)

As-built (verified M2): `team_remember` writes the identity line WITHOUT a
`Record ID:` segment — the CLI-assigned id is canonical and returned in the
tool result; there is no CLI update subcommand to backfill it. The numbered
edit procedure in SKILL.md F6c applies to raw `eden.sh` usage only.

| ID | Case |
|----|------|
| A6-1 | identity line is exactly `Goal: X \| Stage: S \| Owner: R`; body passed through verbatim |
| A6-2 | no pre-generated `Record ID:` placeholder ever survives into the stored content |
| A6-3 | `input_record_ids` cite stored (CLI-assigned) ids — covered via A7 `team_decide` |
| A6-4 | metadata carries goal_id/stage/owner_role/record_type/status/protocol |

### B4. Empty-id / transient-failure handling in tools (T2)

As-built (verified M2): `team_remember` makes a single CLI call and surfaces
the audited empty-id failure loudly; the retry-until-id loop is `eden.sh`'s
`eden_remember` contract (bash tier, B1-2).

| ID | Case |
|----|------|
| B4-1 | `team_remember` with CLI returning empty id → error surfaced, no success confirmation card |
| B4-2 | transient failure (empty id) still fails loudly — never a silent write; retry contract owned by B1-2 |

### A7. Authorisation semantics — `team_decide` (T2)

| ID | Case |
|----|------|
| A7-1 | approve/reject/defer each write an `authorisation_record` referencing the pending record in `input_record_ids` |
| A7-2 | decision note persisted in the record |
| A7-3 | works against a **closed** goal (stranded item): references the actual pending record and notes the router owns continuation |
| A7-4 | defer leaves goal state `pending_authorisation` (no auto-continuation messaging) |

### A8. Steer lifecycle neutrality (T1/T2)

| ID | Case |
|----|------|
| A8-1 | `steer_request` records never affect goal state, counts, or needs-you lists |

---

## 3. Scope B — memory hygiene

F1/F2/F3/F6 discipline made executable. Highest-value scope: these tests
guard against the destructive failure modes ATP has actually observed
(scope-wide forgets, split-brain DB reads/writes, cross-workspace confusion).

### B1. eden.sh failure contract (F3/F6) — bash tier

| ID | Case |
|----|------|
| B1-1 | `eden_remember` success → stdout is **only** the id (parse-clean); CLI logs appear on stderr |
| B1-2 | empty id retried 3 attempts (fixture bin fails twice, succeeds third; sleeps 2 then 5 shimmed via a bash `sleep()` stub and asserted; attempt count = 3) |
| B1-3 | persistent empty id → non-zero exit, loud failure note on stderr naming agent/workspace, stdout stays empty |
| B1-4 | `eden_recall`/`eden_search` without agent_id → non-zero exit + stderr naming `--agent-id` (no silent empty results) |
| B1-5 | CLI exits 0 with empty stdout → treated as failure (non-zero + stderr note) |
| B1-6 | `eden_lookup` not-found is NOT an error (exit 0, `found: false` passes through) |
| B1-7 | sourcing eden.sh with `EDEN_ORG_ID` unset and no TTY → loud failure with exact fix commands, non-zero |
| B1-8 | `EDEN_ENV_FILE` override honored; env vars win over file values; unknown keys skipped; quotes stripped |

### B2. DB-path pinning & `.env`-hijack defense (T2 + T3)

The 2026-09-06 board-went-agents-only incident: a project `.env` set
`EDEN_DB_PATH` so role writes and board reads landed in different DBs.

| ID | Case |
|----|------|
| B2-1 | `EDEN_MEMORY_DB` set → probe skipped entirely (no `health` call observed), env override wins |
| B2-2 | `health` probe extracts `db_path` once per session; every subsequent CLI call pins `--db` (assert fixture argv) |
| B2-3 | `EDEN_DB_PATH` set via env → probe returns that path and `--db` pins to it (writes and reads same file by construction) |
| B2-4 | `dbHint` empty for the default path; `· db ~/…` hint otherwise |
| B2-5 | (T3) project `.env` hijack e2e: goal board read and role write land in the same scratch DB file |

### B3. Workspace scoping (F2) (T2 + T3)

| ID | Case |
|----|------|
| B3-1 | resolution order: explicit param > `ATP_WORKSPACE_ID` > `WORKSPACE_ID` > session cache (git toplevel) > cwd basename |
| B3-2 | `team_status` text and details state the queried workspace + source |
| B3-3 | `team_remember` passes the resolved `--workspace-id` to the CLI (fixture argv) |
| B3-4 | `team_recall` output states the queried workspace |
| B3-5 | (T3) cross-workspace isolation: record written in ws A is `found: false` from ws B |

### B4. Empty-id / transient-failure handling in tools (T2)

See the as-built section above (A6) — B4-1/B4-2 cover the single-call loud
failure; the retry loop is eden.sh's (B1-2).

### B5. API-surface scope safety (F1) (T1/T2)

| ID | Case |
|----|------|
| B5-1 | registered tool set is exactly the six team_* tools — **no** bulk/scope-wide forget, no vacuum/export surface |
| B5-2 | parameter schemas expose no scope-based deletion (per-id lookup/decide only) |
| B5-3 | (bash) any forget path requires an explicit `--id`; no scope flags accepted |

### B6. Genericity — no hardcoded identity (T1 source scan)

| ID | Case |
|----|------|
| B6-1 | `index.ts` + `eden.sh` contain no org/user id values (scan for real-id patterns; fixtures only use `test-org`/`test-user`) — mirrors `check-public-safe.sh` intent at unit level |

### B7. SQL aggregate scoping (T1)

| ID | Case |
|----|------|
| B7-1 | `sqlEscape` neutralizes quote injection in goal/role filters |
| B7-2 | aggregate query filters by org **and** workspace ids (assert SQL string built from cfg) |

---

## 4. Scope C — UI display & interaction

### C1. Goal board rendering (T1)

| ID | Case |
|----|------|
| C1-1 | `boardHeader`/`boardRow` columns align: ANSI-aware `visibleWidth` of each rendered row matches header column widths |
| C1-2 | `stateTag` pill per state (active/blocked/pending_authorisation/continueable/closed) with expected color tags |
| C1-3 | `stageBadge`/`ownerBadge` mapping incl. unknown values fallback |
| C1-4 | `fmtTime`/`relTime` (`3m ago`, future-safe) |
| C1-5 | `displayGoal`/`shortId` truncation to 8 chars; `prettifyGoalId` title suffix present when known |
| C1-6 | long goal titles truncated to board width (`truncateToWidth`), never wrap/bleed |
| C1-7 | in-flight hand-off renders owner column as `→ role` (from A2-6 data) |

### C2. Human-readable text outputs — execute() content (T2)

| ID | Case |
|----|------|
| C2-1 | `team_status` goal lines: `goal \| stage \| owner \| state \| rec=… \| n records` |
| C2-2 | NEEDS HUMAN DECISION lines for pending/blocked goals and for stranded items (goal closed, …) with `/team-approve`/`team_decide` hint |
| C2-3 | `Queried workspace X (source)` line; db-error and empty-state messages |
| C2-4 | `team_recall` text: numbered match list with score/badges/snippet; missing score → `—` |
| C2-5 | `team_lookup` text: readable record card; not-found message |
| C2-6 | `team_decide` text: next step matches the decision (approve → role executes; reject → rework/closure; defer → stays pending) |

### C3. Scored match badges (T1)

| ID | Case |
|----|------|
| C3-1 | score ≥ 0.45 → green badge styling tag; < 0.45 → dim |

### C4. Cards (T1)

| ID | Case |
|----|------|
| C4-1 | record card fields: id, stage/owner/type/status/goal badges, `summarizeMetaValue`/`fmtStored` formatting of metadata |
| C4-2 | decision card shows decision + note + goal |

### C5. ctrl+o expansion (T2)

| ID | Case |
|----|------|
| C5-1 | `renderResult` collapsed vs expanded (`opts.expanded`): longer snippet/clipped body; `clip()` boundaries |

### C6. Empty & filtered boards (T1)

| ID | Case |
|----|------|
| C6-1 | unfiltered empty board message vs goal_id-filtered vs role-filtered messages each name the filter |
| C6-2 | `/team-board` states the workspace |

### C7. Live widget + poller (T1/T2)

| ID | Case |
|----|------|
| C7-1 | `renderWidget`: goal rows present; agents-only fallback when no goals; needs-you rows; footer `ATP n active · m pending` |
| C7-2 | `formatSubagentRow`: `● builder · → edit runner.ts · N turns · Tm`; nested children indented |
| C7-3 | `fmtElapsed` ms → human units |
| C7-4 | `tailJsonl` handles partial lines across reads (`readNewBytes` offset state), tolerates garbage |
| C7-5 | `describeSessionEntry` extracts turns/activity from fixture manifest entries |
| C7-6 | `pollManifest`/`pollChildSessions` against fixture dirs detect new runs and update rows |

### C8. Steer UX (T2)

| ID | Case |
|----|------|
| C8-1 | `themelessSteerLine` exact format `⚠ STEERING for <role>: <message>` |
| C8-2 | `/steer` with ambiguous goal-id prefix refuses (notify captured), no record written |
| C8-3 | `/steer` with full id writes `steer_request` via fixture; role validated against ATP roles |
| C8-4 | `consumePendingSteers` goal-scoped matching: only the FULL goal_id of the calling tool; goal-less calls receive unscoped steers only |
| C8-5 | steers consumed exactly once (second delivery attempt returns none) |
| C8-6 | `team_steer` tool: writes record; error path renders `team_steer error: …` |

### C9. Command guards (T2)

| ID | Case |
|----|------|
| C9-1 | `/team-board` outside interactive mode → "requires interactive mode" error, no overlay |
| C9-2 | all five tools with missing org id → `failMissingOrg` loud error, zero CLI invocations observed |

---

## 5. Explicitly out of scope (for now)

- **Role-subagent LLM compliance** (does the dispatcher actually spawn
  roles correctly?) — model behavior, not deterministic code. A future T4
  scenario tier via the pi SDK could cover the seven-stage lifecycle
  end-to-end against a scratch DB.
- **Eden-memory CLI internals** — external project (`eden-memory` repo owns
  those); here we only test our wrappers' contracts against it.
- **Theme palette specifics** — tests pin color *tags*, not exact palette.
- **Sync/pairing/dream features** of the CLI — untouched by ATP.

## 6. Sequencing & rough size

| Milestone | Content | ~Cases |
|-----------|---------|--------|
| M1 | harness: mock-pi runner, fixtures, export block in index.ts, `tests/setup.sh` | infra ✅ |
| M2 | A1–A5 + A6/A7 + B2/B3/B4/B7 (state machine + scoping/pinning — highest value) | ~63 ✅ |
| M3 | C1–C6 (boards, text outputs, cards) | ~32 ✅ (C2-6 next-step wording covered by A7-1..A7-5) |
| M4 | B1/B4/B5/B6 (eden.sh bash suite, API surface, genericity) | ~18 |
| M5 | C7–C9 (widget/poller/steer) + T3 real-e2e markers (B2-5, B3-5, C8-5b) | ~30 ✅ |

Total: ~100 cases. T1+T2 must run in seconds with no network; T3 behind
`ATP_E2E=1`.

## 7. Repo hygiene when landing

- `tests/` excluded from `install.sh` copy; add README "What's backed up" row
  + install.sh source-layout comment **in the same commit** (docs-sync).
- `.gitignore`: `tests/node_modules/`.
- No real org/user ids or absolute personal paths in fixtures —
  `scripts/check-public-safe.sh` must pass; run it before committing.
- Per F5b: any edit to the live `~/.pi/agent/...` files (the export block)
  must be listed in the working goal's `action_record`.
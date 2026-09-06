/**
 * Agentic Team Protocol — TUI tools for Eden-memory I/O.
 *
 * The ATP skill normally drives Eden-memory through raw `bash` calls to the
 * `eden-memory` CLI. Those built-in bash results can't be restyled, so this
 * extension registers ATP-native tools that wrap the same CLI (and a direct
 * SQLite aggregate for status) and render themed TUI components via
 * `renderCall` / `renderResult`.
 *
 * Tools:
 *   - team_status   — list active goals as a themed, aligned state-pill table
 *   - team_recall   — semantic recall (per agent) with scored match list
 *   - team_remember — store a durable ATP record, render confirmation card
 *   - team_lookup   — fetch a record by id, render a record card
 *
 * Tooling hardening (2026-09-04):
 *   - Every tool accepts an optional `workspace` parameter; resolution order
 *     is explicit param > env ATP_WORKSPACE_ID > env WORKSPACE_ID > session
 *     cache (git toplevel) > cwd default. team_status and team_recall state
 *     the queried workspace in their output and details — no silent
 *     cross-workspace reads or writes.
 *   - team_status also lists pending_authorisation/blocked records belonging
 *     to CLOSED goals (found by scanning each goal's records by goal_id, not
 *     just the latest-record state machine) as NEEDS HUMAN DECISION items.
 *   - team_decide succeeds when the goal state is closed: it references the
 *     actual pending record and notes that the router owns continuation.
 *
 * Defect fixes (2026-09-05, goal atp-smoke-defect-fixes-p1-2026-09-05):
 *   - team_recall/team_lookup no longer pass the unsupported
 *     `--include-content` flag (eden-memory v0.3.141 returns full content
 *     by default, so the flag was dropped, not replaced).
 *   - A goal classifies as closed only on an archival_record (or an
 *     archivist hand-off when the goal already has an archival_record);
 *     mid-flight hand-offs stay continueable instead of rendering closed.
 *   - Steer delivery is goal-scoped: consumePendingSteers matches the FULL
 *     goal_id of the calling tool (goal-less calls deliver only unscoped
 *     steers), steer displays show the full displayGoal() id, and /steer
 *     refuses ambiguous goal-id prefixes instead of taking the first match.
 *
 * Command:
 *   - /team-board  — full-width bordered goal board (esc to close)
 *
 * Lifecycle UX:
 *   On every `subagent` tool_result, a compact goal board is refreshed as a
 *   widget above the editor so the user sees team state update live, without
 *   restyling the (headless) subagent's internal tool calls.
 *   A mid-flight hand_off_record's `next_role` (known protocol roles only)
 *   renders as the goal's incoming owner (`→ researcher`) until the target
 *   role writes its first record: roles write stage records at the END of
 *   their work, so the handing-off role would otherwise own the board for
 *   the whole duration of the next stage.
 *
 * Human-readable output (2026-09-04):
 *   - team_lookup's text output is a readable record card, not a JSON dump.
 *   - team_recall's text output is a numbered match list with role/stage/goal
 *     badges parsed from the identity line; missing scores render as "—".
 *   - Goal boards show relative timestamps ("3m ago"); team_decide's next
 *     step matches the actual decision (defer stays pending); filtered
 *     empty boards say what was filtered; /team-board states the workspace.
 *   - team_lookup/team_recall honour ctrl+o (expanded) for longer bodies.
 *
 * Status/board read from the `metadata` JSON columns the Eden-memory schema
 * already indexes (`goal_id`, `stage`, `record_type`, `status`, `owner_role`),
 * scoped to the current org/workspace, and fall back to the content identity
 * line for older records without structured metadata.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Eden-memory config — GENERIC BY DESIGN (mirrors eden.sh): identity resolves
// env var > ~/.eden-memory/.env; no org/user ids are hardcoded in source.
// ---------------------------------------------------------------------------

interface EdenConfig {
	bin: string;
	userId: string;
	orgId: string;
	workspaceId: string;
	/** How workspaceId was resolved: explicit param, env var, session cache, or cwd. */
	workspaceSource: string;
	db: string;
}

/**
 * Read a single KEY=value entry from ~/.eden-memory/.env (the per-machine
 * config; comments/blanks skipped, surrounding quotes stripped). Returns
 * undefined when the file or key is absent. Nothing identity-related is
 * hardcoded in the source — keep real org/user ids in the config file.
 */
function readEnvFileValue(key: string): string | undefined {
	try {
		const envPath = join(homedir(), ".eden-memory", ".env");
		if (!existsSync(envPath)) return undefined;
		for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const eq = line.indexOf("=");
			if (eq === -1 || line.slice(0, eq).trim() !== key) continue;
			let value = line.slice(eq + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			return value || undefined;
		}
	} catch {
		/* ignore */
	}
	return undefined;
}

/** Org id: env var > ~/.eden-memory/.env. Empty string = unconfigured. */
function readOrgId(): string {
	return process.env.EDEN_ORG_ID?.trim() || readEnvFileValue("EDEN_ORG_ID") || "";
}

/** User id: USER_ID env > config file EDEN_USER_ID > USER/USERNAME env. */
function readUserId(): string {
	return (
		process.env.USER_ID?.trim() ||
		readEnvFileValue("EDEN_USER_ID") ||
		process.env.USER?.trim() ||
		process.env.USERNAME?.trim() ||
		""
	);
}

/**
 * Loud, actionable failure for an unconfigured org id — every eden-memory
 * call and DB query is org-scoped, so missing config must never look like
 * "no matches" (no silent empties).
 */
function missingOrgMessage(): string {
	return (
		'EDEN_ORG_ID is not configured — every call is org-scoped. Fix: add "EDEN_ORG_ID=<your-org>" to ~/.eden-memory/.env ' +
		"or export the env var. To be prompted interactively, re-run install.sh or source ~/.pi/agent/skills/agentic-team-protocol/eden.sh in a terminal."
	);
}

// Workspace is resolved at session_start from `git rev-parse --show-toplevel`
// (matching eden.sh) and cached. Falls back to basename(cwd).
let cachedWorkspace: string | undefined;

// ---------------------------------------------------------------------------
// Live subagent rows + steering queue — everything in plain sight, no overlays.
//
// Data sources (no core changes, mirrors pi-submarine's on-disk artifacts):
//   - <sessionFile>.subagents/manifest.jsonl — episode registry (started /
//     finished / resume records with agent, sessionFile, parentEpisodeId).
//     Tailed incrementally by a 2s poller while any run is active.
//   - child session .jsonl files — canonical transcripts, tailed for the
//     current activity (last tool call / text) and turn counts.
//   - `subagent`/`subagent_resume` tool_result details.run — authoritative
//     SubagentRunView reconciled on completion.
// Steering is ATP-native: /steer (user) and team_steer (orchestrator) write
// steer_request records to Eden-memory; the child role's next team_* call
// consumes them and surfaces the message in its own transcript.
// ---------------------------------------------------------------------------

const TEAM_ROLES = ["dispatcher", "researcher", "builder", "runtime", "verifier", "archivist", "router"];

interface SubagentRow {
	episodeId: string;
	sessionId: string;
	agent: string;
	parentEpisodeId: string | null;
	status: "running" | "completed" | "failed" | "aborted";
	startedAt: number; // epoch ms
	finishedAt?: number;
	turns: number;
	lastActivity: string;
	sessionFile?: string;
}

/** Mirror of pi-submarine's SubagentRunView (arrives in tool_result details). */
interface SubagentRunViewLite {
	episodeId: string;
	sessionId: string;
	agent: string;
	status: "running" | "completed" | "failed" | "aborted";
	turnCount?: number;
	activity?: string;
	children?: SubagentRunViewLite[];
}

interface SteerRecord {
	id: string;
	goalId: string;
	targetRole: string;
	message: string;
	createdAt: number;
}

const subagentRows = new Map<string, SubagentRow>(); // by episodeId
const manifestOffsets = new Map<string, { offset: number; remainder: string }>();
const sessionTails = new Map<string, { offset: number; remainder: string; activity: string }>();
let pollTimer: ReturnType<typeof setInterval> | undefined;
let pollInFlight = false;
let pollCtx: ExtensionContext | undefined;
let widgetDirty = false;

/** Read bytes appended to filePath since offset. Handles truncation. */
function readNewBytes(filePath: string, offset: number): { chunk: string; nextOffset: number } {
	try {
		const size = statSync(filePath).size;
		if (size < offset) offset = 0; // truncated/rotated — start over
		if (size === offset) return { chunk: "", nextOffset: offset };
		const fd = openSync(filePath, "r");
		try {
			const buf = Buffer.alloc(size - offset);
			const bytesRead = readSync(fd, buf, 0, buf.length, offset);
			return { chunk: buf.toString("utf8", 0, bytesRead), nextOffset: offset + bytesRead };
		} finally {
			closeSync(fd);
		}
	} catch {
		return { chunk: "", nextOffset: offset };
	}
}

/** Incrementally parse complete JSONL lines from filePath. */
function tailJsonl(filePath: string, state: { offset: number; remainder: string }): unknown[] {
	const { chunk, nextOffset } = readNewBytes(filePath, state.offset);
	if (!chunk) return [];
	state.offset = nextOffset;
	const text = state.remainder + chunk;
	const lines = text.split("\n");
	state.remainder = lines.pop() ?? "";
	const out: unknown[] = [];
	for (const line of lines) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t));
		} catch {
			/* tolerate junk lines */
		}
	}
	return out;
}

/** Parse the subagent manifest, upserting running/finished episode rows. */
function pollManifest(manifestPath: string): boolean {
	let state = manifestOffsets.get(manifestPath);
	if (!state) {
		state = { offset: 0, remainder: "" };
		manifestOffsets.set(manifestPath, state);
	}
	const records = tailJsonl(manifestPath, state);
	if (records.length === 0) return false;
	let changed = false;
	for (const raw of records) {
		const rec = raw as { type?: string; episodeId?: string; sessionId?: string; parentEpisodeId?: string | null; agent?: string; sessionFile?: string; startedAt?: string; status?: string; finishedAt?: string };
		if (!rec?.episodeId) continue;
		const isStart = rec.type === "started" || rec.type === "resume_started";
		const isFinish = rec.type === "finished" || rec.type === "resume_finished";
		let row = subagentRows.get(rec.episodeId);
		if (isStart) {
			const startedMs = rec.startedAt ? Date.parse(rec.startedAt) || Date.now() : Date.now();
			if (!row) {
				row = {
					episodeId: rec.episodeId,
					sessionId: rec.sessionId ?? "",
					agent: rec.agent ?? "subagent",
					parentEpisodeId: rec.parentEpisodeId ?? null,
					status: "running",
					startedAt: startedMs,
					turns: 0,
					lastActivity: "starting…",
					sessionFile: rec.sessionFile,
				};
				subagentRows.set(rec.episodeId, row);
				changed = true;
			} else {
				row.status = "running";
				row.startedAt = startedMs;
				row.finishedAt = undefined;
				changed = true;
			}
		} else if (isFinish && row) {
			const nextStatus = (rec.status === "completed" || rec.status === "failed" || rec.status === "aborted"
				? rec.status
				: "failed") as SubagentRow["status"];
			if (row.status !== nextStatus) changed = true;
			row.status = nextStatus;
			row.finishedAt = rec.finishedAt ? Date.parse(rec.finishedAt) || Date.now() : Date.now();
			// Stop tailing this child.
			if (row.sessionFile) sessionTails.delete(row.sessionFile);
		}
	}
	// Prune: keep the map bounded (finished rows are dropped oldest-first).
	const finished = [...subagentRows.values()].filter((r) => r.status !== "running").sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
	for (const r of finished.slice(30)) subagentRows.delete(r.episodeId);
	return changed;
}

/** Derive a short activity description from one child-session JSONL entry. */
function describeSessionEntry(entry: unknown): { turns: number; activity: string } | null {
	const e = entry as { type?: string; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean } };
	if (e?.type !== "message" || !e.message) return null;
	const role = e.message.role;
	if (role === "assistant") {
		const content = Array.isArray(e.message.content) ? e.message.content : [];
		const last = content[content.length - 1] as { type?: string; text?: string; name?: string } | undefined;
		let activity = "thinking";
		if (last?.type === "toolCall") activity = `→ ${last.name ?? "tool"}`;
		else if (last?.type === "text" && last.text) activity = clip(last.text, 70);
		return { turns: 1, activity };
	}
	if (role === "toolResult") {
		return { turns: 0, activity: `${e.message.toolName ?? "tool"} ${e.message.isError ? "✗" : "✓"}` };
	}
	return null;
}

/** Tail active child sessions for live activity + turn counts. */
function pollChildSessions(): void {
	for (const row of subagentRows.values()) {
		if (row.status !== "running" || !row.sessionFile) continue;
		let tail = sessionTails.get(row.sessionFile);
		if (!tail) {
			tail = { offset: 0, remainder: "", activity: row.lastActivity };
			sessionTails.set(row.sessionFile, tail);
		}
		const entries = tailJsonl(row.sessionFile, tail);
		for (const entry of entries) {
			const d = describeSessionEntry(entry);
			if (!d) continue;
			row.turns += d.turns;
			if (d.activity) row.lastActivity = d.activity;
		}
	}
}

/** Upsert rows from the authoritative tool_result details.run (recursing children). */
function reconcileRunFromDetails(run: SubagentRunViewLite | undefined, parentEpisodeId: string | null = null): void {
	if (!run?.episodeId) return;
	const existing = subagentRows.get(run.episodeId);
	const row: SubagentRow = existing ?? {
		episodeId: run.episodeId,
		sessionId: run.sessionId,
		agent: run.agent,
		parentEpisodeId,
		status: run.status,
		startedAt: Date.now(),
		turns: 0,
		lastActivity: run.activity ?? "",
	};
	row.status = run.status;
	row.turns = run.turnCount ?? row.turns;
	row.lastActivity = run.activity || row.lastActivity;
	if (run.status !== "running") row.finishedAt = row.finishedAt ?? Date.now();
	subagentRows.set(run.episodeId, row);
	for (const child of run.children ?? []) reconcileRunFromDetails(child, run.episodeId);
}

function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60 ? `:${String(s % 60).padStart(2, "0")}` : ""}`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function sortedSubagentRows(): SubagentRow[] {
	return [...subagentRows.values()].sort((a, b) => {
		if ((a.status === "running") !== (b.status === "running")) return a.status === "running" ? -1 : 1;
		return a.status === "running" ? a.startedAt - b.startedAt : (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
	});
}

function formatSubagentRow(theme: Theme, row: SubagentRow): string {
	const depth = row.parentEpisodeId && subagentRows.has(row.parentEpisodeId) ? 1 : 0;
	const indent = depth > 0 ? "  ↳ " : "";
	const elapsed = fmtElapsed((row.finishedAt ?? Date.now()) - row.startedAt);
	const label = theme.fg("text", theme.bold(row.agent));
	if (row.status === "running") {
		return `${indent}${theme.fg("success", "●")} ${label} ${theme.fg("muted", `· ${row.lastActivity || "working"}`)} ${theme.fg("dim", `· ${row.turns} turns · ${elapsed}`)}`;
	}
	const mark = row.status === "completed" ? theme.fg("success", "✓") : theme.fg("error", row.status === "aborted" ? "⏹" : "✗");
	return `${indent}${mark} ${label} ${theme.fg("dim", `· ${row.status} · ${row.turns} turns · ${elapsed}`)}`;
}

/** Queued steer_request records for this workspace (oldest first). */
async function fetchSteers(pi: ExtensionAPI, ctx: ExtensionContext | undefined): Promise<SteerRecord[]> {
	await resolveDbPath(pi, ctx);
	const cfg = edenConfig(ctx);
	if (!cfg.orgId) return [];
	const sql = `SELECT id, created_at, metadata FROM memories WHERE org_id = '${sqlEscape(cfg.orgId)}' AND workspace_id = '${sqlEscape(cfg.workspaceId)}' AND deleted_at = 0 AND json_extract(metadata, '$.record_type') = 'steer_request' AND json_extract(metadata, '$.status') = 'queued' ORDER BY created_at ASC LIMIT 20;`;
	try {
		const res = await pi.exec("sqlite3", [cfg.db, "-json", sql], { timeout: 10000 });
		if (res.code !== 0) return [];
		const rows = JSON.parse(res.stdout || "[]") as Array<{ id: string; created_at: number | string; metadata: string | null }>;
		return rows.map((r) => {
			const md = parseMetadata(r.metadata) as { goal_id?: string; target_role?: string; steer_message?: string };
			return {
				id: r.id,
				goalId: md.goal_id ?? "",
				targetRole: md.target_role ?? "?",
				message: md.steer_message ?? "",
				createdAt: typeof r.created_at === "string" ? Number(r.created_at) : (r.created_at ?? 0),
			};
		});
	} catch {
		return [];
	}
}

/** Write a steer_request record (used by /steer and team_steer). */
async function writeSteer(
	pi: ExtensionAPI,
	ctx: ExtensionContext | undefined,
	opts: { goalId?: string; role: string; message: string; source: string; workspace?: string },
): Promise<{ ok: boolean; recordId?: string; error?: string }> {
	await resolveDbPath(pi, ctx);
	const cfg = edenConfig(ctx, opts.workspace);
	if (!cfg.orgId) return { ok: false, error: missingOrgMessage() };
	const goalId = opts.goalId ?? "";
	const content = `Goal: ${goalId || "unscoped"} | Stage: action | Owner: ${opts.role}\nSTEER → ${opts.role}: ${opts.message}`;
	const metadata = {
		goal_id: goalId,
		stage: "action",
		owner_role: opts.role,
		record_type: "steer_request",
		status: "queued",
		target_role: opts.role,
		steer_message: opts.message,
		source: opts.source,
		protocol: "agentic-team-protocol",
	};
	const res = await pi.exec(
		cfg.bin,
		[
			"--db", cfg.db,
			"remember",
			"--agent-id", "dispatcher",
			"--user-id", cfg.userId,
			"--org-id", cfg.orgId,
			"--workspace-id", cfg.workspaceId,
			"--content", content,
			"--metadata", JSON.stringify(metadata),
		],
		{ timeout: 30000 },
	);
	const recordId = res.code === 0 ? (res.stdout.match(/"id"\s*:\s*"([^"]+)"/)?.[1] ?? "") : "";
	return recordId ? { ok: true, recordId } : { ok: false, error: res.stderr?.trim() || `eden-memory exited ${res.code}` };
}

/**
 * Child-side steering consumption: fetch queued steer_request records aimed at
 * this role (or "*") and, when `goalId` is given, scoped to that goal or
 * unscoped, mark them delivered, and return display lines the caller
 * prepends to its tool result so the steer lands in the child's own transcript.
 */
async function consumePendingSteers(
	pi: ExtensionAPI,
	ctx: ExtensionContext | undefined,
	cfg: { orgId: string; workspaceId: string; userId: string; bin: string; db: string },
	role: string,
	goalId?: string,
	signal?: AbortSignal,
): Promise<string[]> {
	if (!cfg.orgId || !role) return [];
	// Goal scoping (defect D3): a steer queued for goal A must never reach a
	// role instance working goal B. Calls that declare a goal (team_remember)
	// receive only their own goal's steers plus unscoped ones; goal-less calls
	// (team_recall) deliver only unscoped steers — goal-scoped steers wait for
	// a goal-declaring team_* call, so cross-goal leaks are impossible.
	const goalCond = goalId
		? ` AND (json_extract(metadata, '$.goal_id') IS NULL OR json_extract(metadata, '$.goal_id') = '' OR json_extract(metadata, '$.goal_id') = '${sqlEscape(goalId)}')`
		: ` AND (json_extract(metadata, '$.goal_id') IS NULL OR json_extract(metadata, '$.goal_id') = '')`;
	const sql = `SELECT id, content, metadata FROM memories WHERE org_id = '${sqlEscape(cfg.orgId)}' AND workspace_id = '${sqlEscape(cfg.workspaceId)}' AND deleted_at = 0 AND json_extract(metadata, '$.record_type') = 'steer_request' AND json_extract(metadata, '$.status') = 'queued' AND json_extract(metadata, '$.target_role') IN ('${sqlEscape(role)}', '*')${goalCond} ORDER BY created_at ASC LIMIT 5;`;
	let rows: Array<{ id: string; content: string; metadata: string | null }> = [];
	try {
		const res = await pi.exec("sqlite3", [cfg.db, "-json", sql], { signal, timeout: 10000 });
		if (res.code !== 0) return [];
		rows = JSON.parse(res.stdout || "[]");
	} catch {
		return [];
	}
	const lines: string[] = [];
	for (const r of rows) {
		const md = parseMetadata(r.metadata) as Record<string, unknown>;
		const message = (md.steer_message as string) || "";
		const goalId = (md.goal_id as string) || "";
		if (message) {
			lines.push(themelessSteerLine(goalId, role, message));
		}
		// Mark delivered (best effort; a failed edit means the steer re-delivers
		// on the next team_* call, which is acceptable for control messages).
		try {
			const merged = { ...md, status: "delivered", delivered_at: new Date().toISOString() };
			await pi.exec(
				cfg.bin,
				[
					"--db", cfg.db,
					"edit",
					"--id", r.id,
					"--user-id", cfg.userId,
					"--org-id", cfg.orgId,
					"--workspace-id", cfg.workspaceId,
					"--content", r.content,
					"--metadata", JSON.stringify(merged),
				],
				{ signal, timeout: 30000 },
			);
		} catch {
			/* leave queued */
		}
	}
	return lines;
}

/** Plain-text steer line for tool results (no theme dependency). */
function themelessSteerLine(goalId: string, role: string, message: string): string {
	return `⚠ STEERING for ${role}${goalId ? ` (goal ${displayGoal(goalId)})` : ""}: ${message}`;
}

/** Compose the always-visible widget: goal board + live subagent rows + needs-you + steer queue. */
async function renderWidget(pi: ExtensionAPI, ctx: ExtensionContext | undefined): Promise<void> {
	if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
	const cfg = edenConfig(ctx);
	if (!cfg.orgId) return;
	const theme = ctx.ui.theme;
	const { goals, records } = await fetchGoals(pi, ctx, undefined, {});
	const steers = await fetchSteers(pi, ctx);

	const lines: string[] = [theme.fg("accent", theme.bold(" Goal Board"))];
	if (goals.length > 0) {
		lines.push(boardHeader(theme, true));
		for (const g of goals) lines.push(boardRow(theme, g, true));
	}
	const rows = sortedSubagentRows();
	if (rows.length > 0) {
		if (goals.length > 0) lines.push("");
		for (const r of rows.slice(0, 6)) lines.push(formatSubagentRow(theme, r));
		if (rows.length > 6) lines.push(theme.fg("dim", ` …+${rows.length - 6} more subagent runs`));
	}
	const stranded = findStrandedPending(records, goals);
	const needsYou = needsYouRows(theme, goals, stranded);
	if (needsYou.length > 0) {
		lines.push("");
		lines.push(...needsYou.slice(0, 5));
	}
	if (steers.length > 0) {
		lines.push("");
		for (const s of steers.slice(0, 3)) {
			lines.push(
				theme.fg("warning", `↪ steer→${s.targetRole}`) +
					theme.fg("dim", `${s.goalId ? ` · ${displayGoal(s.goalId)}` : ""}: `) +
					theme.fg("muted", clip(s.message, 70)),
			);
		}
	}

	if (goals.length === 0 && rows.length === 0 && steers.length === 0) {
		ctx.ui.setWidget("atp-board", undefined);
		ctx.ui.setStatus("atp", undefined);
		return;
	}
	ctx.ui.setWidget("atp-board", lines);

	const activeCount = rows.filter((r) => r.status === "running").length;
	const pendingCount = goals.filter((g) => g.state === "pending_authorisation" || g.state === "blocked").length + stranded.length;
	const status = [activeCount > 0 ? `${activeCount} active` : "", pendingCount > 0 ? `${pendingCount} pending` : ""].filter(Boolean).join(" · ");
	ctx.ui.setStatus("atp", status ? `Team ${status}` : undefined);
}

/** 2s poller: manifests + child tails + widget refresh while anything is live. */
function startPoller(pi: ExtensionAPI): void {
	if (pollTimer) return;
	pollTimer = setInterval(() => {
		void (async () => {
			if (pollInFlight) return;
			pollInFlight = true;
			try {
				const ctx = pollCtx;
				if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
				const sessionFile = (ctx.sessionManager as { getSessionFile?: () => string | undefined } | undefined)?.getSessionFile?.();
				let manifestChanged = false;
				if (sessionFile) {
					manifestChanged = pollManifest(`${sessionFile}.subagents/manifest.jsonl`);
				}
				const anyRunning = [...subagentRows.values()].some((r) => r.status === "running");
				if (anyRunning) pollChildSessions();
				if (manifestChanged || anyRunning || widgetDirty) {
					widgetDirty = false;
					await renderWidget(pi, ctx);
				}
			} catch {
				/* never let the poller break the agent loop */
			} finally {
				pollInFlight = false;
			}
		})();
	}, 2000);
}

function stopPoller(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = undefined;
	}
}

/**
 * Resolve the Eden-memory workspace (F2). Resolution order: explicit
 * `workspace` parameter > env ATP_WORKSPACE_ID > env WORKSPACE_ID > the
 * session-start git-toplevel cache > basename(cwd). Every tool funnels its
 * optional workspace param through here, so the resolved scope is always
 * visible in tool output instead of silently assumed.
 */
function edenConfig(ctx: ExtensionContext | undefined, workspaceParam?: string): EdenConfig {
	const bin = process.env.EDEN_MEMORY_BIN || "eden-memory";
	const userId = readUserId();
	const orgId = readOrgId();
	let workspaceId: string;
	let workspaceSource: string;
	if (workspaceParam && workspaceParam.trim()) {
		workspaceId = workspaceParam.trim();
		workspaceSource = "explicit param";
	} else if (process.env.ATP_WORKSPACE_ID?.trim()) {
		workspaceId = process.env.ATP_WORKSPACE_ID.trim();
		workspaceSource = "env ATP_WORKSPACE_ID";
	} else if (process.env.WORKSPACE_ID?.trim()) {
		workspaceId = process.env.WORKSPACE_ID.trim();
		workspaceSource = "env WORKSPACE_ID";
	} else if (cachedWorkspace) {
		workspaceId = cachedWorkspace;
		workspaceSource = "session (git toplevel)";
	} else {
		workspaceId = ctx ? basename(ctx.cwd) : basename(process.cwd());
		workspaceSource = "cwd";
	}
	const db = process.env.EDEN_MEMORY_DB || resolvedDbPath || join(homedir(), ".eden-memory", "default.db");
	return { bin, userId, orgId, workspaceId, workspaceSource, db };
}

// --- DB path resolution — follow the CLI's own resolution -------------------

/**
 * The eden-memory CLI resolves its DB from a project-level `.env` in cwd
 * (`EDEN_DB_PATH`) before falling back to ~/.eden-memory/default.db — a
 * resolution the extension cannot see. A leftover setup fixture once pointed
 * the CLI at a test DB under /tmp while the board read the default path:
 * role writes landed in /tmp, the goal board went agents-only (2026-09-06,
 * workspace eden-memory). The DB path is therefore probed ONCE per session
 * from the CLI itself (`health` reports the effective `db_path`), and `--db`
 * is pinned on every extension CLI call with the same value, so board reads
 * and role writes land in the same file by construction. EDEN_MEMORY_DB
 * stays an explicit extension-side override (probing is skipped when set).
 */
let resolvedDbPath: string | null = null;
let dbProbeDone = false;
let dbProbeInFlight: Promise<string | null> | null = null;

async function resolveDbPath(
	pi: ExtensionAPI,
	ctx: ExtensionContext | undefined,
): Promise<string | null> {
	if (dbProbeDone) return resolvedDbPath;
	if (process.env.EDEN_MEMORY_DB?.trim()) {
		// Explicit override wins; probing the CLI would be wasted work.
		dbProbeDone = true;
		return null;
	}
	if (!dbProbeInFlight) {
		dbProbeInFlight = (async () => {
			try {
				const bin = process.env.EDEN_MEMORY_BIN || "eden-memory";
				const res = await pi.exec(bin, ["health"], { timeout: 15000 });
				if (res.code === 0) {
					const m = res.stdout.match(/"db_path"\s*:\s*"([^"]+)"/);
					if (m?.[1]) resolvedDbPath = m[1];
				}
			} catch {
				/* fall back to the default path */
			} finally {
				dbProbeDone = true;
				dbProbeInFlight = null;
			}
			return resolvedDbPath;
		})();
	}
	return dbProbeInFlight;
}

/** ` · db ~/path/to.db` when the resolved DB is not the default location. */
function dbHint(cfg: EdenConfig): string {
	const def = join(homedir(), ".eden-memory", "default.db");
	if (cfg.db === def) return "";
	const home = homedir();
	const shown = cfg.db.startsWith(home) ? `~${cfg.db.slice(home.length)}` : cfg.db;
	return ` · db ${shown}`;
}

/** Tool failure result for an unconfigured org id (loud + actionable). */
function failMissingOrg(tool: string) {
	const text = `${tool} failed: ${missingOrgMessage()}`;
	return { content: [{ type: "text", text }], details: { error: text } };
}

// ---------------------------------------------------------------------------
// Record model + parsing
// ---------------------------------------------------------------------------

interface ParsedRecord {
	id: string; // memory row id (canonical record id)
	agentId: string;
	content: string;
	createdAt: number; // unix seconds
	goalId: string;
	stage: string;
	owner: string;
	recordType: string;
	status: string;
	/** hand_off_record only: the role ownership transfers to (may be junk/empty). */
	nextRole: string;
}

interface DbRow {
	id: string;
	agent_id: string;
	content: string;
	created_at: number | string;
	metadata: string | null;
}

const IDENTITY_RE =
	/Goal:\s*([^\s|]+)\s*\|\s*(?:Record ID:\s*([^\s|]*)\s*\|)?\s*Stage:\s*([^\s|]+)\s*\|\s*Owner:\s*([^\s|]+)/;

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw);
		return typeof v === "object" && v ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function parseRecord(row: DbRow): ParsedRecord | null {
	const md = parseMetadata(row.metadata);
	const createdAt =
		typeof row.created_at === "string" ? Number(row.created_at) : (row.created_at ?? 0);

	// Prefer structured metadata; fall back to the content identity line.
	let goalId = (md.goal_id as string | undefined) ?? "";
	let stage = (md.stage as string | undefined) ?? "";
	let owner = (md.owner_role as string | undefined) ?? "";
	const recordType = (md.record_type as string | undefined) ?? "";
	const status = (md.status as string | undefined) ?? "";
	// next_role only exists on hand_off_records (structured metadata; older
	// raw-CLI writes embed the JSON blob in the content — regex fallback).
	let nextRole = (md.next_role as string | undefined) ?? "";
	if (!nextRole) {
		const m = row.content?.match(/"next_role"\s*:\s*"([^"]+)"/);
		if (m) nextRole = m[1]!;
	}

	if (!goalId || !stage || !owner) {
		const m = row.content?.match(IDENTITY_RE);
		if (m) {
			const [, g, , s, o] = m;
			goalId = goalId || g;
			stage = stage || s;
			owner = owner || o;
		}
	}

	if (!goalId) return null; // not an ATP record
	return {
		id: row.id,
		agentId: row.agent_id,
		content: row.content,
		createdAt: createdAt || 0,
		goalId,
		stage: stage || "unknown",
		owner: owner || row.agent_id || "unknown",
		recordType,
		status,
		nextRole,
	};
}

/**
 * Protocol roles a hand_off_record's `next_role` must name for the board to
 * treat it as an ownership transfer. Hand-offs also carry junk values
 * ("closure", "parent_assistant_to_router") or none at all — those are not
 * activations and are ignored for the incoming-owner display.
 */
const ATP_ROLES = new Set([
	"dispatcher",
	"researcher",
	"builder",
	"runtime",
	"verifier",
	"archivist",
	"router",
]);

type GoalState = "active" | "blocked" | "pending_authorisation" | "continueable" | "closed";

/**
 * Classify a goal's state from the latest record's type/status/stage,
 * mirroring the SKILL router lifecycle rules (not the stage string alone).
 * `hasArchival` = the goal has at least one archival_record. A goal is closed
 * only on an archival_record (or an archivist hand-off that follows one):
 * every ATP hand_off_record uses stage hand_off_or_closure, so mid-flight
 * hand-offs (researcher→builder, router→role, …) must stay continueable.
 */
function classifyState(rec: ParsedRecord, hasArchival = false): GoalState {
	const status = rec.status.toLowerCase();
	const type = rec.recordType.toLowerCase();
	const stage = rec.stage.toLowerCase();

	if (status.includes("blocked")) return "blocked";
	if (status.includes("pending") || type.includes("pending_authorisation")) return "pending_authorisation";
	if (type === "authorisation_record") {
		// Human decision recorded via team_decide: approve/reject hand control
		// back to the router; defer keeps the goal visibly awaiting the human.
		if (status.includes("defer")) return "pending_authorisation";
		return "continueable";
	}
	if (type === "archival_record") return "closed";
	if (type === "hand_off_record" && rec.owner.toLowerCase() === "archivist" && hasArchival) return "closed";
	if (type === "verdict") {
		if (status.includes("green")) return "active"; // -> archivist
		if (status.includes("red")) return "continueable"; // -> rework
		if (status.includes("blocked")) return "blocked";
	}
	if (stage.includes("recording_and_archival") || stage.includes("archival")) return "active";
	return "continueable";
}

interface GoalSummary {
	goalId: string;
	stage: string;
	/** Display-only stage label, closure-aware: "Closure" ⟺ state is closed. */
	stageLabel: string;
	owner: string;
	/** Incoming owner while a hand-off is in flight (target role hasn't written yet). */
	nextOwner?: string;
	state: GoalState;
	recordType: string;
	status: string;
	latestRecordId: string;
	latestBody: string;
	createdAt: number;
	recordCount: number;
}

function summarizeGoals(records: ParsedRecord[], filter?: { goalId?: string; role?: string }): GoalSummary[] {
	const byGoal = new Map<string, ParsedRecord[]>();
	for (const r of records) {
		if (r.recordType === "steer_request") continue; // control messages, not lifecycle state
		if (filter?.goalId && r.goalId !== filter.goalId) continue;
		if (filter?.role && r.agentId !== filter.role && r.owner !== filter.role) continue;
		const arr = byGoal.get(r.goalId) ?? [];
		arr.push(r);
		byGoal.set(r.goalId, arr);
	}
	const summaries: GoalSummary[] = [];
	for (const [goalId, arr] of byGoal) {
		// Stable sort on equal timestamps keeps the SQL's rowid-desc tie-break,
		// so the newest inserted record (e.g. a pending_authorisation parked
		// right after an action run_log) wins "latest" deterministically.
		arr.sort((a, b) => b.createdAt - a.createdAt);
		const latest = arr[0]!;
		const hasArchival = arr.some((r) => r.recordType === "archival_record");
		const state = classifyState(latest, hasArchival);
		// In-flight hand-off display: roles write their stage record at the END
		// of their work, so between a hand_off_record and the target role's
		// first write the board would keep showing the handing-off role as
		// owner. If the newest hand-off transfers to a known protocol role that
		// has not produced any record after it yet, show that incoming owner.
		// Closed goals are excluded — the archivist's closure hand-off (and
		// junk next_role values like "closure") is not an activation.
		let nextOwner: string | undefined;
		if (state !== "closed") {
			const handOff = arr.find((r) => r.recordType === "hand_off_record");
			const target = handOff?.nextRole ?? "";
			if (handOff && ATP_ROLES.has(target) && target !== handOff.owner) {
				const acted = arr.some(
					(r) => r.createdAt > handOff.createdAt && (r.owner === target || r.agentId === target),
				);
				if (!acted) nextOwner = target;
			}
		}
		const stageLabel =
			state === "closed" ? "Closure" : latest.stage === "hand_off_or_closure" ? "Hand-off" : humanize(latest.stage);
		// Feed the goal-title map from the goal_record body (newest wins; arr is
		// newest-first). Missing/empty titles fall back to prettifyGoalId.
		const gr = arr.find((r) => r.recordType === "goal_record");
		const title = gr ? extractGoalTitle(gr) : "";
		if (title) goalTitles.set(goalId, title);
		else goalTitles.delete(goalId);
		summaries.push({
			goalId,
			stage: latest.stage,
			stageLabel,
			owner: latest.owner,
			nextOwner,
			state,
			recordType: latest.recordType,
			status: latest.status,
			latestRecordId: latest.id,
			latestBody: bodyOf(latest),
			createdAt: latest.createdAt,
			recordCount: arr.length,
		});
	}
	summaries.sort((a, b) => b.createdAt - a.createdAt);
	return summaries;
}

// ---------------------------------------------------------------------------
// Pending-after-closure scan (F4-tooling)
// ---------------------------------------------------------------------------

/**
 * Is this record an OPEN pending_authorisation/blocked item? Decisions
 * (authorisation_record) are not open items — a defer decision already
 * re-surfaces via classifyState on the latest record.
 */
function isPendingItem(rec: ParsedRecord): boolean {
	const type = (rec.recordType || "").toLowerCase();
	const status = (rec.status || "").toLowerCase();
	if (type === "authorisation_record") return false;
	return (
		status.includes("pending") || type.includes("pending_authorisation") || status.includes("blocked")
	);
}

/** Latest open pending/blocked record for one goal (goal_id scan, F4). */
function latestPendingForGoal(records: ParsedRecord[], goalId: string): ParsedRecord | undefined {
	let best: ParsedRecord | undefined;
	for (const r of records) {
		if (r.goalId !== goalId || !isPendingItem(r)) continue;
		if (!best || r.createdAt >= best.createdAt) best = r;
	}
	return best;
}

/**
 * A pending/blocked item the latest-record state machine cannot surface:
 * its goal is closed, so the closure/archival record won "latest" and the
 * item is invisible in the per-goal state column. Found by scanning every
 * goal's records by goal_id instead. An item whose pending record was
 * followed by an authorisation_record (a recorded decision) is resolved and
 * not stranded.
 */
interface StrandedPending {
	goalId: string;
	recordId: string;
	recordType: string;
	question: string;
}

function findStrandedPending(records: ParsedRecord[], goals: GoalSummary[]): StrandedPending[] {
	const stateByGoal = new Map(goals.map((g) => [g.goalId, g.state] as const));
	const decidedAfter = new Map<string, number>();
	const latestPending = new Map<string, ParsedRecord>();
	for (const r of records) {
		if ((r.recordType || "").toLowerCase() === "authorisation_record") {
			decidedAfter.set(r.goalId, Math.max(decidedAfter.get(r.goalId) ?? 0, r.createdAt));
		}
	}
	for (const r of records) {
		if (!isPendingItem(r)) continue;
		const prev = latestPending.get(r.goalId);
		if (!prev || r.createdAt >= prev.createdAt) latestPending.set(r.goalId, r);
	}
	const stranded: StrandedPending[] = [];
	for (const [goalId, rec] of latestPending) {
		if (stateByGoal.get(goalId) !== "closed") continue;
		if ((decidedAfter.get(goalId) ?? -1) >= rec.createdAt) continue;
		stranded.push({
			goalId,
			recordId: rec.id,
			recordType: rec.recordType || "pending",
			question: bodyOf(rec) || `see record ${rec.id}`,
		});
	}
	stranded.sort((a, b) => a.goalId.localeCompare(b.goalId));
	return stranded;
}

// ---------------------------------------------------------------------------
// Shared data fetch (used by team_status, /team-board, and the live widget)
// ---------------------------------------------------------------------------

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

/**
 * Query Eden-memory's SQLite DB for ATP records in the current org/workspace,
 * scoped via the indexed `metadata.goal_id` column.
 */
async function fetchGoals(
	pi: ExtensionAPI,
	ctx: ExtensionContext | undefined,
	signal: AbortSignal | undefined,
	filter?: { goalId?: string; role?: string; workspace?: string },
): Promise<{ goals: GoalSummary[]; records: ParsedRecord[]; dbError?: string }> {
	await resolveDbPath(pi, ctx);
	const cfg = edenConfig(ctx, filter?.workspace);
	if (!cfg.orgId) {
		return { goals: [], records: [], dbError: missingOrgMessage() };
	}
	const where = [
		`org_id = '${sqlEscape(cfg.orgId)}'`,
		`workspace_id = '${sqlEscape(cfg.workspaceId)}'`,
		"deleted_at = 0",
		"json_extract(metadata, '$.goal_id') IS NOT NULL",
	];
	if (filter?.goalId) where.push(`json_extract(metadata, '$.goal_id') = '${sqlEscape(filter.goalId)}'`);
	const sql = `SELECT id, agent_id, content, created_at, metadata FROM memories WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT 1000;`;

	const res = await pi.exec("sqlite3", [cfg.db, "-json", sql], { signal, timeout: 15000 });
	if (res.code !== 0) {
		return { goals: [], records: [], dbError: res.stderr?.trim() || `sqlite3 exited ${res.code}` };
	}

	let rows: DbRow[] = [];
	try {
		rows = JSON.parse(res.stdout || "[]");
	} catch {
		rows = [];
	}

	const records: ParsedRecord[] = [];
	for (const r of rows) {
		// SQLite CLI may return created_at as a number; metadata as a JSON string.
		const p = parseRecord(r);
		if (p) records.push(p);
	}
	return { goals: summarizeGoals(records, filter), records };
}

// ---------------------------------------------------------------------------
// Themed rendering helpers
// ---------------------------------------------------------------------------

const STATE_META: Record<GoalState, { label: string; color: string }> = {
	active: { label: "[active]", color: "accent" },
	blocked: { label: "[blocked]", color: "warning" },
	pending_authorisation: { label: "[pending]", color: "error" },
	continueable: { label: "[continue]", color: "muted" },
	closed: { label: "[closed]", color: "success" },
};

function stateTag(theme: Theme, state: GoalState): string {
	const m = STATE_META[state];
	return theme.fg(m.color, m.label);
}

function stageBadge(theme: Theme, stage: string): string {
	return theme.fg("mdCode", humanize(stage));
}

function ownerBadge(theme: Theme, owner: string): string {
	return theme.fg("accent", owner);
}

function fmtTime(unix: number): string {
	if (!unix) return "—";
	const d = new Date(unix * 1000);
	return d.toISOString().slice(5, 16).replace("T", " ");
}

/** Human relative time for a live board: "just now", "3m ago", "2h ago", "5d ago"; absolute beyond 30d. */
function relTime(unix: number): string {
	if (!unix) return "—";
	const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
	if (s < 45) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
	return fmtTime(unix);
}

/** Humanize a stored_at value (unix seconds, ISO string, or anything) for display. */
function fmtStored(stored: unknown): string {
	if (!stored) return "—";
	if (typeof stored === "number") return fmtTime(stored);
	if (typeof stored === "string") {
		const t = Date.parse(stored);
		if (!Number.isNaN(t)) {
			const unix = Math.floor(t / 1000);
			return `${relTime(unix)} (${fmtTime(unix)})`;
		}
		return stored;
	}
	return String(stored);
}

/** Clip a single-line snippet to n chars without cutting the last word hard (adds an ellipsis). */
function clip(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? t.slice(0, Math.max(1, n - 1)).trimEnd() + "…" : t;
}

/** Colour for a record status string (success/warning/error/muted). */
function statusColor(status: string): string {
	const s = (status || "").toLowerCase();
	if (s.includes("block") || s.includes("red") || s.includes("reject")) return "error";
	if (s.includes("pending") || s.includes("defer")) return "warning";
	if (s.includes("green") || s.includes("approved") || s.includes("completed") || s.includes("pass")) return "success";
	return "muted";
}

/** Metadata keys that are identity/transport noise — hidden from lookup cards unless expanded. */
const META_NOISE_KEYS = new Set([
	"agent_id",
	"org_id",
	"user_id",
	"workspace_id",
	"protocol",
	"goal_id",
	"stage",
	"owner_role",
	"record_type",
	"status",
	"stored_at",
	"ttl_ms",
]);

/** Compact a metadata value for display: short-id arrays, raw strings, JSON for the rest. */
function summarizeMetaValue(v: unknown): string {
	// Older eden-memory CLI writes sometimes wrap values as {"item": …} — unwrap.
	if (v && typeof v === "object" && !Array.isArray(v)) {
		const obj = v as Record<string, unknown>;
		if (Object.keys(obj).length === 1 && "item" in obj) return summarizeMetaValue(obj.item);
	}
	if (Array.isArray(v)) {
		return v.map((x) => (typeof x === "string" ? shortId(x, 8) : JSON.stringify(x))).join(", ");
	}
	if (typeof v === "string") return v;
	return JSON.stringify(v);
}

/** Strip leading ATP identity line(s) from raw record content, keeping any prose after an inline identity. */
function stripIdentity(content: string): string {
	const lines = content.split("\n");
	let i = 0;
	while (i < lines.length && i < 3) {
		const m = lines[i].match(IDENTITY_RE);
		if (!m) break;
		// The identity may be a prefix of a line with real prose after it (e.g.
		// "… | Owner: router — CLOSURE RUN_LOG: …"). Keep that prose.
		const rest = lines[i].slice(m[0].length).replace(/^[\s—–-]+/, "");
		if (rest) {
			lines[i] = rest;
			break;
		}
		i++; // the line was purely the identity line; drop it
	}
	return lines.slice(i).join("\n").trim();
}

/** Preferred prose keys when unwrapping a JSON-blob body (first match wins). */
const BODY_PROSE_KEYS = ["note", "reason", "summary", "statement", "finding", "text", "content", "result"] as const;

/**
 * Unwrap one standalone JSON-object string into readable text: prose keys as
 * text, scalar extras as key=value pairs; falls back to the raw string when
 * there is nothing readable to extract.
 */
function unwrapJsonBlob(t: string): string {
	try {
		const v: unknown = JSON.parse(t);
		if (typeof v !== "object" || v === null || Array.isArray(v)) return t;
		const md = v as Record<string, unknown>;
		const prose = BODY_PROSE_KEYS.filter((k) => typeof md[k] === "string" && md[k]).map((k) => String(md[k]));
		const scalars = Object.keys(md)
			.filter((k) => !META_NOISE_KEYS.has(k) && !(BODY_PROSE_KEYS as readonly string[]).includes(k) && typeof md[k] !== "object")
			.map((k) => `${k}=${summarizeMetaValue(md[k])}`);
		return [...prose, ...(scalars.length > 0 ? [scalars.join(" | ")] : [])].join("\n") || t;
	} catch {
		return t;
	}
}

/**
 * Humanize a record body for display. Some records written via the raw CLI
 * path carry JSON objects as the body (whole body, or per-line blobs). Unwrap
 * any standalone JSON-object line; leave prose untouched.
 */
function humanizeBody(content: string): string {
	const body = stripIdentity(content);
	if (!body) return "";
	const t = body.trim();
	if (t.startsWith("{")) {
		if (t.endsWith("}")) return unwrapJsonBlob(t); // whole body is one blob
		return t
			.split("\n")
			.map((line) => {
				const s = line.trim();
				return s.startsWith("{") && s.endsWith("}") ? unwrapJsonBlob(s) : line;
			})
			.join("\n");
	}
	return t;
}

function shortId(id: string, n = 8): string {
	return id ? id.slice(0, n) : "—";
}

/** Goal id → short human title, populated by summarizeGoals from goal_record bodies. */
const goalTitles = new Map<string, string>();

/**
 * Prettify a raw goal id for display: strip the leading "atp-" prefix and a
 * trailing -YYYY-MM-DD date stamp, then title-case hyphen-separated words
 * (letter+digit tokens like p1/t1 become P1/T1).
 */
function prettifyGoalId(id: string): string {
	let t = id.startsWith("atp-") ? id.slice(4) : id;
	t = t.replace(/-\d{4}-\d{2}-\d{2}$/, ""); // trailing date stamp
	return t
		.split("-")
		.filter(Boolean)
		.map((w) => (/\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
		.join(" ");
}

/**
 * Extract a short human-readable "title" from a goal_record body JSON
 * (identity line stripped first). Returns "" when absent or unparsable.
 */
function extractGoalTitle(rec: ParsedRecord): string {
	const raw = stripIdentity(rec.content ?? "").trim();
	if (!raw.startsWith("{")) return "";
	try {
		const v = JSON.parse(raw) as Record<string, unknown>;
		const t = typeof v.title === "string" ? v.title.trim() : "";
		return t ? clip(t, 60) : "";
	} catch {
		return "";
	}
}

/** Goal display name: goal_record "title" if known, else prettified id. */
function displayGoal(id: string): string {
	return goalTitles.get(id) ?? prettifyGoalId(id);
}

/** Latest record body with the identity line stripped (and JSON blobs unwrapped), for decision prompts. */
function bodyOf(rec: ParsedRecord): string {
	return clip(humanizeBody(rec.content ?? "").replace(/\s*\n+\s*/g, " · "), 200);
}

/** Replace `_` separators with spaces and capitalise the first letter. */
function humanize(s: string): string {
	if (!s) return s;
	const t = s.replace(/_/g, " ");
	return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Pad a (possibly ANSI-styled) string to a column width using visible width. */
function padCol(s: string, w: number): string {
	const vw = visibleWidth(s);
	if (vw >= w) return s;
	return s + " ".repeat(w - vw);
}

/** Truncate then pad so columns line up without overflowing. */
function col(theme: Theme, text: string, w: number, color: string): string {
	return padCol(theme.fg(color, truncateToWidth(text, w, "")), w);
}

/** Goal column: strip the `atp-` prefix and render bold for readability. */
function goalCol(theme: Theme, id: string, w: number): string {
	return padCol(theme.fg("text", theme.bold(truncateToWidth(displayGoal(id), w, ""))), w);
}

const COL_STATE = 10;
const COL_GOAL = 36;
const COL_STAGE = 22;
const COL_OWNER = 12;
const COL_RECORD = 10;
const COL_WHEN = 9;
const COL_COUNTS = 5;

/** One aligned board row. `compact` drops the record-id + time columns. */
function boardRow(theme: Theme, g: GoalSummary, compact: boolean): string {
	const state = padCol(stateTag(theme, g.state), COL_STATE);
	const goal = goalCol(theme, g.goalId, COL_GOAL);
	const stage = col(theme, g.stageLabel, COL_STAGE, "mdCode");
	// While a hand-off is in flight, the owner column shows the incoming role
	// (dim arrow + accent role) — ownership has already transferred to it.
	const owner = g.nextOwner
		? padCol(
				theme.fg("dim", "→ ") + theme.fg("accent", truncateToWidth(g.nextOwner, COL_OWNER - 2, "")),
				COL_OWNER,
			)
		: col(theme, g.owner, COL_OWNER, "accent");
	const counts = padCol(theme.fg("dim", `(${g.recordCount})`), COL_COUNTS);
	if (compact) return `${state}  ${goal}  ${stage}  ${owner}  ${counts.trimEnd()}`;
	const rec = col(theme, shortId(g.latestRecordId, COL_RECORD), COL_RECORD, "muted");
	const when = padCol(theme.fg("dim", relTime(g.createdAt)), COL_WHEN);
	return `${state}  ${goal}  ${stage}  ${owner}  ${rec}  ${when}  ${counts.trimEnd()}`;
}

function boardHeader(theme: Theme, compact: boolean): string {
	const dim = (s: string, w: number) => padCol(theme.fg("dim", s), w);
	const state = dim("STATE", COL_STATE);
	const goal = dim("GOAL", COL_GOAL);
	const stage = dim("STAGE", COL_STAGE);
	const owner = dim("OWNER", COL_OWNER);
	if (compact) return `${state}  ${goal}  ${stage}  ${owner}`;
	const rec = dim("RECORD", COL_RECORD);
	const when = dim("UPDATED", COL_WHEN);
	const counts = dim("RECS", COL_COUNTS);
	return `${state}  ${goal}  ${stage}  ${owner}  ${rec}  ${when}  ${counts}`;
}

function emptyBoard(theme: Theme, filter?: { goalId?: string; role?: string }): string[] {
	if (filter?.goalId || filter?.role) {
		const what = filter.goalId ? `goal ${displayGoal(filter.goalId)}` : `role ${filter.role}`;
		return [theme.fg("dim", `No team records found for ${what} in Eden-memory (check the workspace line above).`)];
	}
	return [
		theme.fg("dim", "No active goals found in Eden-memory."),
		"",
		theme.fg("muted", "Start one with ") + theme.fg("accent", "/team <goal>"),
	];
}

/**
 * "Needs you" action list: pending_authorisation / blocked goals that owe a
 * human decision, with the question extracted from the latest record.
 */
function needsYouRows(theme: Theme, goals: GoalSummary[], stranded: StrandedPending[] = []): string[] {
	const pending = goals.filter((g) => g.state === "pending_authorisation" || g.state === "blocked");
	if (pending.length === 0 && stranded.length === 0) return [];
	const lines = [
		theme.fg("warning", theme.bold(` ⚠ Needs you (${pending.length + stranded.length}) — decide with /team-approve`)),
	];
	for (const g of pending) {
		const mark = g.state === "blocked" ? theme.fg("warning", "■ blocked") : theme.fg("error", "□ decide");
		const q = truncateToWidth(g.latestBody || "(see record for details)", 72, "…");
		lines.push(`   ${mark}  ${theme.fg("text", theme.bold(displayGoal(g.goalId)))} — ${theme.fg("muted", q)}`);
		lines.push(
			`     ${theme.fg("dim", `rec ${shortId(g.latestRecordId, 8)} · team_decide goal_id="${g.goalId}"`)}`,
		);
	}
	// F4: pending/blocked items stranded on CLOSED goals — team_decide still
	// works on closed goals; the router handles any continuation.
	for (const s of stranded) {
		const q = truncateToWidth(s.question, 72, "…");
		lines.push(
			`   ${theme.fg("warning", "■ closed")}  ${theme.fg("text", theme.bold(displayGoal(s.goalId)))} — ${theme.fg("muted", q)}`,
		);
		lines.push(
			`     ${theme.fg("dim", `rec ${shortId(s.recordId, 8)} · goal closed · team_decide goal_id="${s.goalId}"`)}`,
		);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const TeamStatusParams = Type.Object({
	goal_id: Type.Optional(Type.String({ description: "Filter to a single goal_id" })),
	role: Type.Optional(
		Type.String({
			description: "Filter by team role: dispatcher, researcher, builder, runtime, verifier, archivist, router",
		}),
	),
	workspace: Type.Optional(
		Type.String({
			description: "Eden-memory workspace to query (optional). Resolution: explicit param > env ATP_WORKSPACE_ID > session default. The output states the queried workspace.",
		}),
	),
});

const TeamRecallParams = Type.Object({
	agent_id: Type.String({
		description: "Eden-memory agent_id scope (CLI requires this). Use the role name, e.g. dispatcher. Recall is scoped to records stored under this agent_id.",
	}),
	query: Type.String({ description: "Semantic recall query" }),
	limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
	workspace: Type.Optional(
		Type.String({
			description: "Eden-memory workspace to recall from (optional). Resolution: explicit param > env ATP_WORKSPACE_ID > session default. The output states the queried workspace.",
		}),
	),
});

const TeamRememberParams = Type.Object({
	agent_id: Type.String({ description: "Clean role name (dispatcher, researcher, builder, runtime, verifier, archivist, router)" }),
	goal_id: Type.String({ description: "Goal UUID this record belongs to" }),
	stage: Type.String({
		description: "Lifecycle stage, e.g. goal_receipt, routing_and_assignment, context_gathering, action, verification, recording_and_archival, hand_off_or_closure, blocked, pending_authorisation, cleanup",
	}),
	owner_role: Type.String({ description: "Owning role for this record" }),
	record_type: Type.Optional(
		Type.String({
			description: "Record type, e.g. goal_record, dispatch_instruction, context_summary, action_record, verdict, archival_record, run_log, cleanup_record, hand_off_record. Indexed in metadata; drives state classification.",
		}),
	),
	status: Type.Optional(
		Type.String({
			description: "Record status, e.g. in_progress, completed, blocked, pending_authorisation. Indexed in metadata; drives state classification (verdict green/red/blocked).",
		}),
	),
	body: Type.String({ description: "Record body content (after the identity line)" }),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Additional JSON metadata. goal_id/stage/owner_role/record_type/status/protocol are set automatically.",
		}),
	),
	workspace: Type.Optional(
		Type.String({
			description: "Eden-memory workspace for this record (optional). Resolution: explicit param > env ATP_WORKSPACE_ID > session default. The output states the written workspace.",
		}),
	),
});

const TeamLookupParams = Type.Object({
	id: Type.String({ description: "Eden-memory record id (UUID)" }),
	workspace: Type.Optional(
		Type.String({
			description: "Eden-memory workspace to look up in (optional). Resolution: explicit param > env ATP_WORKSPACE_ID > session default.",
		}),
	),
});

const TeamDecideParams = Type.Object({
	goal_id: Type.String({ description: "Goal awaiting a human decision" }),
	decision: Type.Union([Type.Literal("approve"), Type.Literal("reject"), Type.Literal("defer")], {
		description: "Human decision on the pending item",
	}),
	note: Type.Optional(Type.String({ description: "Optional decision note recorded with the authorisation" })),
	workspace: Type.Optional(
		Type.String({
			description: "Eden-memory workspace of the goal (optional). Resolution: explicit param > env ATP_WORKSPACE_ID > session default.",
		}),
	),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Resolve workspace once per session (git toplevel basename, like eden.sh).
	pi.on("session_start", async (_event, ctx) => {
		try {
			const res = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 3000 });
			if (res.code === 0 && res.stdout.trim()) cachedWorkspace = basename(res.stdout.trim());
			else cachedWorkspace = basename(ctx.cwd);
		} catch {
			cachedWorkspace = basename(ctx.cwd);
		}
	});

	// --- team_status ---------------------------------------------------------
	pi.registerTool({
		name: "team_status",
		label: "Team Status",
		description:
			"List active Agentic Team Protocol goals from Eden-memory with current stage, owner role, latest record id, and state (active/blocked/pending_authorisation/continueable/closed). Reads indexed metadata, scoped to the current org/workspace (optional workspace param overrides; the output states the queried workspace). Renders a themed, aligned table. Goals pending_authorisation/blocked are additionally listed as NEEDS HUMAN DECISION items with the question extracted from the latest record, and pending/blocked records stranded on CLOSED goals are found by scanning each goal's records and listed the same way — surface these to the user.",
		promptSnippet: "Show active team goals, stages, owners, and state from Eden-memory",
		promptGuidelines: [
			"Use team_status (not raw bash + eden.sh) when the user asks for /team-status or a goal/role status report.",
			"Always surface pending_authorisation/blocked items in the result to the user — including pending/blocked records stranded on CLOSED goals (team_decide works on closed goals; the router handles continuation). They need a human decision (/team-approve or team_decide). Do not decide unilaterally.",
		],
		parameters: TeamStatusParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cfg = edenConfig(ctx, params.workspace);
			const filter: { goalId?: string; role?: string; workspace?: string } = {};
			if (params.goal_id) filter.goalId = params.goal_id;
			if (params.role) filter.role = params.role;
			if (params.workspace) filter.workspace = params.workspace;
			const { goals, records, dbError } = await fetchGoals(pi, ctx, signal, filter);

			// F4: also surface pending/blocked items on CLOSED goals, found by
			// scanning each goal's records by goal_id rather than trusting the
			// latest-record state machine.
			const stranded = findStrandedPending(records, goals);

			const pending = goals.filter((g) => g.state === "pending_authorisation" || g.state === "blocked");
			const goalLines = goals.map(
				(g) =>
					`${displayGoal(g.goalId)} | ${g.stageLabel} | ${g.nextOwner ? `${g.owner} → ${g.nextOwner}` : g.owner} | ${g.state} | rec=${shortId(g.latestRecordId)} | ${g.recordCount} records`,
			);
			const decisionLines = pending.map(
				(g) =>
					`NEEDS HUMAN DECISION (${g.state}): ${displayGoal(g.goalId)} — ${g.latestBody || `see record ${g.latestRecordId}`}. Surface to the user; decide via /team-approve or team_decide.`,
			);
			const strandedLines = stranded.map(
				(s) =>
					`NEEDS HUMAN DECISION (goal closed, ${humanize(s.recordType)}): ${displayGoal(s.goalId)} — ${s.question}. rec=${shortId(s.recordId)}. team_decide goal_id="${s.goalId}" still works on closed goals; the router handles continuation.`,
			);

			const ws = `workspace ${cfg.workspaceId} (${cfg.workspaceSource})${dbHint(cfg)}`;
			const summaryText = dbError
				? `Eden-memory db error (${ws}): ${dbError}`
				: goals.length === 0 && stranded.length === 0
					? `No active goals found in Eden-memory (${ws}).`
					: [`Queried ${ws}.`, "", ...decisionLines, ...strandedLines, "", ...goalLines].join("\n");

			return {
				content: [{ type: "text", text: summaryText }],
				details: {
					goals,
					stranded,
					count: goals.length,
					filter,
					dbError,
					workspace: cfg.workspaceId,
					workspaceSource: cfg.workspaceSource,
				},
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("team_status"));
			if (args.goal_id) text += ` ${theme.fg("accent", args.goal_id)}`;
			if (args.role) text += ` ${theme.fg("muted", `role=${args.role}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme, _context) {
			const details = result.details as
				| { goals?: GoalSummary[]; stranded?: StrandedPending[]; dbError?: string; filter?: { goalId?: string; role?: string }; workspace?: string; workspaceSource?: string }
				| undefined;
			const goals = details?.goals ?? [];
			const stranded = details?.stranded ?? [];

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(" Goal Board ")), 0, 0));
			if (details?.workspace) {
				container.addChild(
					new Text(theme.fg("dim", ` workspace: ${details.workspace} (${details.workspaceSource ?? "default"})`), 0, 0),
				);
			}
			container.addChild(new Spacer(1));

			if (details?.dbError) {
				container.addChild(new Text(theme.fg("error", `eden-memory db error: ${details.dbError}`), 0, 0));
				return container;
			}
			if (goals.length === 0) {
				for (const l of emptyBoard(theme, details?.filter)) container.addChild(new Text(l, 0, 0));
				return container;
			}

			container.addChild(new Text(boardHeader(theme, false), 0, 0));
			for (const g of goals) container.addChild(new Text(boardRow(theme, g, false), 0, 0));
			const needsYou = needsYouRows(theme, goals, stranded);
			if (needsYou.length > 0) {
				container.addChild(new Spacer(1));
				for (const l of needsYou) container.addChild(new Text(l, 0, 0));
				container.addChild(new Spacer(1));
			}
			container.addChild(new Text(theme.fg("dim", `${goals.length} goal(s)`), 0, 0));
			return container;
		},
	});

	// --- team_recall ---------------------------------------------------------
	pi.registerTool({
		name: "team_recall",
		label: "Team Recall",
		description:
			"Semantic recall over Eden-memory for team context, scoped to an agent_id (the eden-memory CLI requires it). Returns a readable, numbered match list — score, record id, role/stage/goal badges from the identity line, and a snippet — with scored match badges in renderResult (green ≥ 0.45, dim below; ctrl+o for longer snippets). For cross-role goal rehydration prefer team_status or team_lookup.",
		promptSnippet: "Recall team context from Eden-memory by semantic query (scoped to agent_id)",
		promptGuidelines: [
			"Use team_recall (not raw bash + eden.sh) when a team role needs to rehydrate its own prior context from Eden-memory. Pass agent_id = the role name.",
		],
		parameters: TeamRecallParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await resolveDbPath(pi, ctx);
			const cfg = edenConfig(ctx, params.workspace);
			if (!cfg.orgId) return failMissingOrg("team_recall");
			// Surface any steering queued for this role before the match list.
			// team_recall carries no goal_id param, so only unscoped steers deliver here.
			const steerLines = await consumePendingSteers(pi, ctx, cfg, params.agent_id, undefined, signal);
			const limit = params.limit ?? 10;
			const res = await pi.exec(
				cfg.bin,
				[
					"--db", cfg.db,
					"recall",
					"--agent-id", params.agent_id,
					"--user-id", cfg.userId,
					"--org-id", cfg.orgId,
					"--workspace-id", cfg.workspaceId,
					"--query", params.query,
					"--limit", String(limit),
				],
				{ signal, timeout: 30000 },
			);

			let results: Array<{ id: string; content: string; score?: number; agent_id?: string }> = [];
			if (res.code === 0) {
				try {
					const parsed = JSON.parse(res.stdout || "{}");
					if (Array.isArray(parsed)) results = parsed;
					else if (Array.isArray(parsed.results)) results = parsed.results;
					else if (Array.isArray(parsed.memories)) results = parsed.memories;
				} catch {
					results = [];
				}
			}

			const ws = `workspace ${cfg.workspaceId} (${cfg.workspaceSource})${dbHint(cfg)}`;
			// A CLI error is not "no matches" (no silent empty results).
			const text = res.code !== 0
				? `team_recall failed on ${ws}: ${res.stderr?.trim() || `eden-memory exited ${res.code}`}`
				: results.length === 0
					? `No matches for: ${params.query} (queried ${ws})`
					: [
							`Queried ${ws}. ${results.length} match(es), best first:`,
							...results.map((r, i) => {
								// Identity line carries goal/stage/owner — surface it instead of raw dumps.
								const m = (r.content ?? "").match(IDENTITY_RE);
								const scope = [m?.[4] ?? r.agent_id ?? "", m?.[3] ? humanize(m[3]) : "", m?.[1] ? `goal ${displayGoal(m[1])}` : ""]
									.filter(Boolean)
									.join(" · ");
								const score = typeof r.score === "number" ? r.score.toFixed(2) : "—";
								return `${i + 1}. [${score}] ${r.id}${scope ? ` · ${scope}` : ""}\n   ${clip(humanizeBody(r.content ?? "").replace(/\s*\n+\s*/g, " · "), 140)}`;
							}),
						].join("\n");

			return {
				content: [{ type: "text", text: [...steerLines, text].join("\n") }],
				details: {
					results,
					steers: steerLines.length > 0 ? steerLines : undefined,
					query: params.query,
					agent_id: params.agent_id,
					workspace: cfg.workspaceId,
					workspaceSource: cfg.workspaceSource,
					error: res.code !== 0 ? res.stderr : undefined,
				},
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_recall ")) +
					theme.fg("accent", args.agent_id) +
					" " +
					theme.fg("muted", `"${args.query}"`),
				0,
				0,
			);
		},

		renderResult(result, opts, theme, _context) {
			const details = result.details as { results?: Array<{ id: string; content: string; score?: number }>; workspace?: string; workspaceSource?: string; error?: string } | undefined;
			const results = details?.results ?? [];

			if (details?.error) return new Text(theme.fg("error", `team_recall error: ${details.error.trim()}`), 0, 0);
			if (results.length === 0) return new Text(theme.fg("dim", "No matches"), 0, 0);

			const expanded = opts?.expanded ?? false;
			const c = new Container();
			if (details?.workspace) {
				c.addChild(new Text(theme.fg("dim", `workspace ${details.workspace} (${details.workspaceSource ?? "default"})`), 0, 0));
			}
			c.addChild(new Text(theme.fg("muted", `${results.length} match(es):`), 0, 0));
			for (const r of results) {
				const score = r.score;
				const scoreText = typeof score === "number" ? score.toFixed(2) : "—";
				const scoreColor = typeof score === "number" && score >= 0.45 ? "success" : "dim";
				const m = (r.content ?? "").match(IDENTITY_RE);
				const stageBadge = m?.[3] ? `  ${theme.fg("mdCode", humanize(m[3]))}` : "";
				const goalBadge = m?.[1] ? `  ${theme.fg("dim", displayGoal(m[1]))}` : "";
				const snippet = clip(humanizeBody(r.content ?? "").replace(/\s*\n+\s*/g, " · "), expanded ? 400 : 96);
				c.addChild(
					new Text(
						theme.fg(scoreColor, `[${scoreText}]`) +
							" " +
							theme.fg("accent", shortId(r.id, 8)) +
							stageBadge +
							goalBadge +
							"\n   " +
							theme.fg("muted", snippet),
						0,
						0,
					),
				);
			}
			if (!expanded) {
				c.addChild(new Text(theme.fg("dim", ` (ctrl+o for longer snippets)`), 0, 0));
			}
			return c;
		},
	});

	// --- team_remember -------------------------------------------------------
	pi.registerTool({
		name: "team_remember",
		label: "Team Remember",
		description:
			"Store a durable team record in Eden-memory. Writes a searchable identity line plus structured metadata (goal_id, stage, owner_role, record_type, status, protocol) so the record is indexed and classifiable. renderResult shows a confirmation card with the new record id and stage badge.",
		promptSnippet: "Store a durable team record in Eden-memory",
		promptGuidelines: [
			"Use team_remember (not raw bash + eden.sh) when a team role writes a goal_record, dispatch_instruction, context_summary, action_record, verdict, archival_record, run_log, cleanup_record, or hand_off_record. Pass record_type and status so the goal state classifies correctly.",
		],
		parameters: TeamRememberParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await resolveDbPath(pi, ctx);
			const cfg = edenConfig(ctx, params.workspace);
			if (!cfg.orgId) return failMissingOrg("team_remember");
			// Surface any steering queued for this role — the steer lands in the
			// child's own transcript via this tool result (plain sight, no polling).
			// Goal-scoped: deliver only steers aimed at this call's goal (plus unscoped).
			const steerLines = await consumePendingSteers(pi, ctx, cfg, params.agent_id, params.goal_id, signal);
			// Identity line for human/recall searchability. The canonical record
			// id is the memory row id (returned by the CLI); there is no update
			// subcommand to backfill it into content, so it is not embedded here.
			const identity = `Goal: ${params.goal_id} | Stage: ${params.stage} | Owner: ${params.owner_role}`;
			const content = `${identity}\n${params.body}`;
			const metadata = {
				goal_id: params.goal_id,
				stage: params.stage,
				owner_role: params.owner_role,
				record_type: params.record_type ?? "",
				status: params.status ?? "in_progress",
				protocol: "agentic-team-protocol",
				...(params.metadata ?? {}),
			};

			const res = await pi.exec(
				cfg.bin,
				[
					"--db", cfg.db,
					"remember",
					"--agent-id", params.agent_id,
					"--user-id", cfg.userId,
					"--org-id", cfg.orgId,
					"--workspace-id", cfg.workspaceId,
					"--content", content,
					"--metadata", JSON.stringify(metadata),
				],
				{ signal, timeout: 30000 },
			);

			let recordId = "";
			if (res.code === 0) {
				const m = res.stdout.match(/"id"\s*:\s*"([^"]+)"/);
				recordId = m?.[1] ?? "";
			}

			const okText = recordId
				? `Stored team record ${recordId} (goal ${params.goal_id}, stage ${params.stage}, owner ${params.owner_role}) into workspace ${cfg.workspaceId}${cfg.workspaceSource === "explicit param" ? " [explicit param]" : ""}.`
				: `Failed to store team record${res.code !== 0 ? `: ${res.stderr?.trim() || `eden-memory exited ${res.code}`}` : " — eden-memory returned no record id"}.`;

			return {
				content: [{ type: "text", text: [...steerLines, okText].join("\n") }],
				details: {
					recordId,
					steers: steerLines.length > 0 ? steerLines : undefined,
					goalId: params.goal_id,
					stage: params.stage,
					owner: params.owner_role,
					recordType: params.record_type ?? "",
					status: params.status ?? "in_progress",
					workspace: cfg.workspaceId,
					workspaceSource: cfg.workspaceSource,
					// Empty id with exit 0 is the audited silent-write failure: make it loud.
					error:
						res.code !== 0
							? res.stderr
							: recordId
								? undefined
								: "eden-memory returned success but no record id",
				},
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_remember ")) +
					stageBadge(theme, args.stage) +
					" " +
					ownerBadge(theme, args.owner_role) +
					" " +
					theme.fg("muted", shortId(args.goal_id, 8)),
				0,
				0,
			);
		},

		renderResult(result, _opts, theme, _context) {
			const details = result.details as { recordId?: string; goalId?: string; stage?: string; owner?: string; recordType?: string; error?: string } | undefined;
			if (details?.error) return new Text(theme.fg("error", `team_remember error: ${details.error.trim()}`), 0, 0);
			if (!details?.recordId) return new Text(theme.fg("error", "team_remember: no record id returned"), 0, 0);

			const c = new Container();
			c.addChild(
				new Text(
					theme.fg("success", "✓ stored ") +
						theme.fg("accent", shortId(details.recordId, 12)) +
						"  " +
						stageBadge(theme, details.stage ?? "?") +
						"  " +
						ownerBadge(theme, details.owner ?? "?"),
					0,
					0,
				),
			);
			if (details.recordType) c.addChild(new Text(theme.fg("muted", `type=${humanize(details.recordType)}`), 0, 0));
			c.addChild(new Text(theme.fg("muted", `goal ${shortId(details.goalId ?? "", 12)}`), 0, 0));
			return c;
		},
	});

	// --- team_lookup ---------------------------------------------------------
	pi.registerTool({
		name: "team_lookup",
		label: "Team Lookup",
		description:
			"Fetch a single Eden-memory record by id. The text output is a readable record card (id, stage/owner/type/status/goal, extra metadata, then the content) — no raw JSON. renderResult shows a themed record card with badges; ctrl+o expands the full body plus extra metadata.",
		promptSnippet: "Fetch a single team record from Eden-memory by id",
		promptGuidelines: ["Use team_lookup (not raw bash + eden.sh) when a team role needs a specific record by id."],
		parameters: TeamLookupParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await resolveDbPath(pi, ctx);
			const cfg = edenConfig(ctx, params.workspace);
			if (!cfg.orgId) return failMissingOrg("team_lookup");
			const res = await pi.exec(
				cfg.bin,
				[
					"--db", cfg.db,
					"lookup",
					"--user-id", cfg.userId,
					"--org-id", cfg.orgId,
					"--workspace-id", cfg.workspaceId,
					"--id", params.id,
				],
				{ signal, timeout: 15000 },
			);

			let found = false;
			let record: { id: string; content?: string; metadata?: Record<string, unknown>; stored_at?: string } | null = null;
			if (res.code === 0) {
				try {
					const parsed = JSON.parse(res.stdout || "{}");
					found = parsed.found === true;
					if (found) {
						record = { id: parsed.id, content: parsed.content, metadata: parsed.metadata, stored_at: parsed.metadata?.stored_at };
					}
				} catch {
					found = false;
				}
			}

			const ws = `workspace ${cfg.workspaceId} (${cfg.workspaceSource})${dbHint(cfg)}`;
			// Human/LLM-readable record card — no raw JSON dumps.
			const text = res.code !== 0
				? `team_lookup failed on ${ws}: ${res.stderr?.trim() || `eden-memory exited ${res.code}`}`
				: record
					? (() => {
							const md = record.metadata ?? {};
							const fields = [
								`stage=${md.stage ?? "?"}`,
								`owner=${md.owner_role ?? "?"}`,
								md.record_type ? `type=${md.record_type}` : undefined,
								md.status ? `status=${md.status}` : undefined,
								md.goal_id ? `goal=${md.goal_id}` : undefined,
								`stored=${md.stored_at ?? "—"}`,
							]
								.filter((x) => x !== undefined)
								.join(" | ");
							const extra = Object.keys(md)
								.filter((k) => !META_NOISE_KEYS.has(k))
								.map((k) => `${k}=${summarizeMetaValue(md[k])}`)
								.join(" | ");
							return [
								`Record ${record.id} — ${ws}`,
								fields,
								extra ? `extra: ${extra}` : undefined,
								"",
								humanizeBody(record.content ?? ""),
							]
								.filter((x) => x !== undefined)
								.join("\n");
						})()
					: `Record ${params.id} not found (${ws})`;
			return {
				content: [{ type: "text", text }],
				details: {
					record,
					found,
					id: params.id,
					workspace: cfg.workspaceId,
					workspaceSource: cfg.workspaceSource,
					error: res.code !== 0 ? res.stderr : undefined,
				},
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_lookup ")) + theme.fg("accent", shortId(args.id, 12)),
				0,
				0,
			);
		},

		renderResult(result, opts, theme, _context) {
			const details = result.details as { record?: { id: string; content?: string; metadata?: Record<string, unknown>; stored_at?: string }; found?: boolean; error?: string } | undefined;
			if (details?.error) return new Text(theme.fg("error", `team_lookup error: ${details.error.trim()}`), 0, 0);
			if (!details?.found || !details?.record) return new Text(theme.fg("dim", "Record not found"), 0, 0);

			const rec = details.record;
			const md = rec.metadata ?? {};
			const stage = (md.stage as string) ?? "?";
			const owner = (md.owner_role as string) ?? "?";
			const type = (md.record_type as string) ?? "";
			const status = (md.status as string) ?? "";
			const expanded = opts?.expanded ?? false;

			const c = new Container();
			c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			c.addChild(
				new Text(
					theme.fg("accent", theme.bold(` ${shortId(rec.id, 12)} `)) +
						"  " +
						stageBadge(theme, stage) +
						"  " +
						ownerBadge(theme, owner) +
						(type ? "  " + theme.fg("muted", humanize(type)) : "") +
						(status ? "  " + theme.fg(statusColor(status), `● ${status}`) : ""),
					0,
					0,
				),
			);
			c.addChild(
				new Text(
					theme.fg("dim", `stored ${fmtStored(md.stored_at ?? rec.stored_at)}`) +
						(md.goal_id ? theme.fg("dim", `  ·  goal ${displayGoal(String(md.goal_id))}`) : ""),
					0,
					0,
				),
			);
			const body = expanded
				? humanizeBody(rec.content ?? "")
				: clip(humanizeBody(rec.content ?? "").replace(/\s*\n+\s*/g, " · "), 160);
			c.addChild(new Text(theme.fg("muted", body), 0, 0));
			if (expanded) {
				const extra = Object.keys(md)
					.filter((k) => !META_NOISE_KEYS.has(k))
					.map((k) => `${k}=${summarizeMetaValue(md[k])}`);
				if (extra.length > 0) {
					c.addChild(new Text(theme.fg("dim", `metadata: ${extra.join(" | ")}`), 0, 0));
				}
			}
			return c;
		},
	});

	// --- team_decide ---------------------------------------------------------
	pi.registerTool({
		name: "team_decide",
		label: "Team Decide",
		description:
			"Record the user's decision on a goal that is pending_authorisation or blocked (approve/reject/defer) as a durable authorisation_record in Eden-memory, then continue via the router. approve → the owning role executes the prepared action; reject → router rework/closure; defer → stays pending. Renders a decision card.",
		promptSnippet: "Record a human approve/reject/defer decision for a pending team goal",
		promptGuidelines: [
			"Use team_decide when the user approves, rejects, or defers a pending_authorisation item surfaced by team_status or /team-approve. After recording, immediately spawn the router subagent so the goal continues (defer: no spawn needed).",
		],
		parameters: TeamDecideParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await resolveDbPath(pi, ctx);
			const cfg = edenConfig(ctx, params.workspace);
			if (!cfg.orgId) return failMissingOrg("team_decide");
			const { goals, records } = await fetchGoals(
				pi,
				ctx,
				signal,
				{ goalId: params.goal_id, workspace: params.workspace },
			);
			const goal = goals[0];
			// F4: reference the actual pending/blocked record being decided, even
			// when the goal's latest record is something else (e.g. the goal was
			// closed while the item was still undecided).
			const priorRecordId = latestPendingForGoal(records, params.goal_id)?.id ?? goal?.latestRecordId ?? "";
			const goalClosed = goal?.state === "closed";

			const status =
				params.decision === "approve" ? "approved" : params.decision === "reject" ? "rejected" : "deferred";
			const identity = `Goal: ${params.goal_id} | Stage: pending_authorisation | Owner: dispatcher`;
			const note = params.note?.trim() ? ` — ${params.note.trim()}` : "";
			const content = `${identity}\nHuman decision (${cfg.userId || "unknown"}): ${status}${note}\nDecided on pending record: ${priorRecordId || "unknown"}${goalClosed ? "\nGoal state: closed — decision recorded post-closure; the router handles continuation." : ""}`;
			const metadata = {
				goal_id: params.goal_id,
				stage: "pending_authorisation",
				owner_role: "dispatcher",
				record_type: "authorisation_record",
				status,
				decision: params.decision,
				decided_by: cfg.userId,
				decided_at: new Date().toISOString(),
				input_record_ids: priorRecordId ? [priorRecordId] : [],
				protocol: "agentic-team-protocol",
			};

			const res = await pi.exec(
				cfg.bin,
				[
					"--db", cfg.db,
					"remember",
					"--agent-id", "dispatcher",
					"--user-id", cfg.userId,
					"--org-id", cfg.orgId,
					"--workspace-id", cfg.workspaceId,
					"--content", content,
					"--metadata", JSON.stringify(metadata),
				],
				{ signal, timeout: 30000 },
			);

			let recordId = "";
			if (res.code === 0) {
				recordId = res.stdout.match(/"id"\s*:\s*"([^"]+)"/)?.[1] ?? "";
			}

			const nextStep =
				params.decision === "approve"
					? goalClosed
						? "Goal state is closed — decision recorded; the router decides how to continue."
						: "Spawn the router subagent to route the goal to the owning role for execution."
					: params.decision === "reject"
						? goalClosed
							? "Goal state is closed — decision recorded; the router decides rework or final closure."
							: "Spawn the router subagent to route rework or closure."
						: "Goal stays pending_authorisation — the item remains on the Needs-you list.";

			const text = recordId
				? `Recorded authorisation_record ${recordId} (${status}) for goal ${params.goal_id} in workspace ${cfg.workspaceId}. ${nextStep}`
				: `Failed to record decision: ${res.stderr?.trim() || `eden-memory exited ${res.code}`}`;

			return {
				content: [{ type: "text", text }],
				details: {
					recordId,
					decision: params.decision,
					status,
					goalId: params.goal_id,
					priorRecordId,
					goalClosed,
					workspace: cfg.workspaceId,
					workspaceSource: cfg.workspaceSource,
					note: params.note ?? "",
					error: res.code !== 0 ? res.stderr : undefined,
				},
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_decide ")) +
					theme.fg("accent", args.decision) +
					" " +
					theme.fg("muted", displayGoal(args.goal_id ?? "")),
				0,
				0,
			);
		},

		renderResult(result, _opts, theme, _context) {
			const details = result.details as {
				recordId?: string;
				decision?: string;
				status?: string;
				goalId?: string;
				note?: string;
				goalClosed?: boolean;
				error?: string;
			} | undefined;
			if (details?.error) return new Text(theme.fg("error", `team_decide error: ${details.error.trim()}`), 0, 0);
			if (!details?.recordId) return new Text(theme.fg("error", "team_decide: decision not recorded"), 0, 0);

			const verb = details.decision === "approve" ? "✓ approved" : details.decision === "reject" ? "✗ rejected" : "⏸ deferred";
			const color = details.decision === "approve" ? "success" : details.decision === "reject" ? "error" : "warning";
			const c = new Container();
			c.addChild(
				new Text(
					theme.fg(color, theme.bold(` ${verb} `)) +
						"  " +
						theme.fg("text", theme.bold(displayGoal(details.goalId ?? "?"))) +
						"  " +
						theme.fg("dim", shortId(details.recordId, 12)),
					0,
					0,
				),
			);
			if (details.note) c.addChild(new Text(theme.fg("muted", details.note), 0, 0));
			// Decision-specific next step (defer does NOT continue the goal).
			const next =
				details.decision === "defer"
					? "Stays pending_authorisation — still on the Needs-you list"
					: details.goalClosed
						? "Goal already closed — the router decides how to continue"
						: details.decision === "reject"
							? "Next: spawn the router → rework or closure"
							: "Next: spawn the router → owning role executes";
			c.addChild(new Text(theme.fg("dim", next), 0, 0));
			return c;
		},
	});

	// --- team_steer ----------------------------------------------------------
	pi.registerTool({
		name: "team_steer",
		label: "Team Steer",
		description:
			"Queue a steering message for a running team role (e.g. the builder on the current goal). The message is stored in Eden-memory and delivered into the role's own transcript at its next team_* tool call; it also appears on the goal-board widget until consumed. Use when a subagent is working and needs a correction or extra instruction.",
		promptSnippet: "Queue a steering message for a running team role",
		promptGuidelines: [
			"Use team_steer when a role is mid-run and needs redirection; prefer it over interrupting the parent turn.",
			"For an immediate hard stop, interrupt instead (Esc) and continue the child with subagent_resume.",
		],
		parameters: Type.Object({
			role: Type.String({
				description:
					"Target team role: dispatcher, researcher, builder, runtime, verifier, archivist, or router",
			}),
			message: Type.String({ description: "Steering instruction for the role" }),
			goal_id: Type.Optional(Type.String({ description: "Goal to scope the steer to (optional; matched for display)" })),
			workspace: Type.Optional(
				Type.String({
					description: "Eden-memory workspace (optional). Resolution: explicit param > env ATP_WORKSPACE_ID > session default.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const res = await writeSteer(pi, ctx, {
				goalId: params.goal_id ?? "",
				role: params.role,
				message: params.message,
				source: "team_steer",
				workspace: params.workspace,
			});
			const text = res.ok
				? `Steer queued for ${params.role}${params.goal_id ? ` (goal ${displayGoal(params.goal_id)})` : ""} — lands at the role's next team_* call.`
				: `Failed to queue steer: ${res.error}`;
			void renderWidget(pi, ctx);
			return {
				content: [{ type: "text", text }],
				details: { ok: res.ok, recordId: res.recordId, role: params.role, error: res.error },
			};
		},

		renderCall(args, theme, _context) {
			return new Text(
				theme.fg("toolTitle", theme.bold("team_steer ")) +
					theme.fg("accent", args.role) +
					" " +
					theme.fg("muted", clip(args.message ?? "", 60)),
				0,
				0,
			);
		},

		renderResult(result, _opts, theme, _context) {
			const details = result.details as { ok?: boolean; recordId?: string; role?: string; error?: string } | undefined;
			if (details?.error) return new Text(theme.fg("error", `team_steer error: ${details.error.trim()}`), 0, 0);
			return new Text(
				theme.fg("success", "↪ steer queued ") + theme.fg("accent", details?.role ?? "?") + theme.fg("dim", `  ${shortId(details?.recordId ?? "", 12)}`),
				0,
				0,
			);
		},
	});

	// --- /team-board command ------------------------------------------------
	pi.registerCommand("team-board", {
		description: "Show a full-width bordered team goal board (esc to close)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/team-board requires interactive mode", "error");
				return;
			}

			const filter: { goalId?: string; role?: string } = {};
			const a = args.trim();
			if (a) {
				if (/^[0-9a-f-]{8,}$/i.test(a) || a.startsWith("atp-")) filter.goalId = a;
				else filter.role = a;
			}
			const { goals, records, dbError } = await fetchGoals(pi, ctx, undefined, filter);
			const stranded = findStrandedPending(records, goals);
			const cfg = edenConfig(ctx);

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				const c = new Container();
				c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				c.addChild(new Text(theme.fg("accent", theme.bold(" Goal Board ")), 0, 0));
				c.addChild(new Text(theme.fg("dim", ` workspace: ${cfg.workspaceId} (${cfg.workspaceSource})`), 0, 0));
				c.addChild(new Spacer(1));

				if (dbError) {
					c.addChild(new Text(theme.fg("error", `eden-memory db error: ${dbError}`), 0, 0));
				} else if (goals.length === 0) {
					for (const l of emptyBoard(theme, filter)) c.addChild(new Text(l, 0, 0));
				} else {
					c.addChild(new Text(boardHeader(theme, true), 0, 0));
					for (const g of goals) c.addChild(new Text(boardRow(theme, g, true), 0, 0));
					const needsYou = needsYouRows(theme, goals, stranded);
					if (needsYou.length > 0) {
						c.addChild(new Spacer(1));
						for (const l of needsYou) c.addChild(new Text(l, 0, 0));
					}
				}

				c.addChild(new Spacer(1));
				c.addChild(new Text(theme.fg("dim", "Press Esc to close"), 0, 0));

				return {
					render: (w: number) => c.render(w),
					invalidate: () => c.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done();
					},
				};
			});
		},
	});

	// --- /steer command -----------------------------------------------------
	pi.registerCommand("steer", {
		description: "Queue a steering message for a team role: /steer [goal] <role> <message>",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			if (tokens.length < 2) {
				ctx.ui.notify("Usage: /steer [goal-id] <role> <message> — roles: " + TEAM_ROLES.join(", "), "info");
				return;
			}
			const { goals } = await fetchGoals(pi, ctx, undefined, {});
			let goalId = "";
			let roleIdx = 0;
			if (!TEAM_ROLES.includes(tokens[0])) {
				const first = tokens[0].toLowerCase();
				const matches = goals.filter(
					(g) => g.goalId.toLowerCase().startsWith(first) || displayGoal(g.goalId).toLowerCase().startsWith(first),
				);
				if (matches.length === 0) {
					ctx.ui.notify(`/steer: '${first}' is not a role (${TEAM_ROLES.join(", ")}) or a known goal id`, "error");
					return;
				}
				if (matches.length > 1) {
					// Refuse ambiguous prefixes — never silently pick the first match.
					ctx.ui.notify(
						`/steer: '${first}' matches multiple goals (${matches.map((g) => displayGoal(g.goalId)).join(", ")}) — type more of the goal id`,
						"error",
					);
					return;
				}
				goalId = matches[0]!.goalId;
				roleIdx = 1;
			}
			const role = tokens[roleIdx];
			if (!TEAM_ROLES.includes(role)) {
				ctx.ui.notify(`/steer: unknown role '${role}' — roles: ${TEAM_ROLES.join(", ")}`, "error");
				return;
			}
			const message = tokens.slice(roleIdx + 1).join(" ");
			if (!message) {
				ctx.ui.notify("/steer: message is empty", "error");
				return;
			}
			if (!goalId) {
				const active = goals.filter((g) => g.state !== "closed");
				if (active.length === 1) goalId = active[0].goalId;
				else if (active.length > 1) {
					ctx.ui.notify("/steer: multiple active goals — pass a goal id first: /steer <goal-id> <role> <message>", "error");
					return;
				}
			}
			const res = await writeSteer(pi, ctx, { goalId, role, message, source: "/steer" });
			if (res.ok) {
				ctx.ui.notify(`↪ steer queued for ${role}${goalId ? ` on ${displayGoal(goalId)}` : ""} — lands at its next team_* call`, "info");
			} else {
				ctx.ui.notify(`steer failed: ${res.error}`, "error");
			}
			await renderWidget(pi, ctx);
		},
	});

	// --- Lifecycle UX: always-visible board widget (plain sight, no overlays)
	// Reconciles authoritative run state from subagent/subagent_resume results
	// and renders goal board + live subagent rows + needs-you + steer queue.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "subagent" && event.toolName !== "subagent_resume") return;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		try {
			const details = (event as { details?: { run?: SubagentRunViewLite } }).details;
			reconcileRunFromDetails(details?.run);
			widgetDirty = true;
			await renderWidget(pi, ctx);
		} catch {
			/* never let UX refresh break the agent loop */
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// (workspace caching above) + capture session context for the poller.
		pollCtx = ctx;
		startPoller(pi);
	});

	pi.on("session_shutdown", async () => {
		stopPoller();
		pollCtx = undefined;
		subagentRows.clear();
		manifestOffsets.clear();
		sessionTails.clear();
		widgetDirty = false;
		cachedWorkspace = undefined;
	});
}


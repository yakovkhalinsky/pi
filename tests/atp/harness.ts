/**
 * ATP test harness (tests/TEST-SCOPE.md §1) — M1.
 *
 * Three seams over the agentic-team-protocol extension:
 *   1. mock `pi`  — captures registerTool/registerCommand/on; `exec` runs real
 *      child processes (real `sqlite3` CLI + the stub eden-memory fixture
 *      binary) so the extension's actual CLI argv/SQL is exercised.
 *   2. mock `ctx` — cwd/mode/hasUI + capturing ui (notify/setWidget/setStatus).
 *   3. mock `Theme` — passthrough (width-safe) or real-ANSI tagged mode.
 *
 * Plus fixture builders: an in-memory-shape SQLite DB mirroring the real
 * eden-memory `memories` table (built with node:sqlite) and the stub CLI
 * binary. Runs under `node --test` with Node's native TS type-stripping —
 * no external test dependencies.
 */
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The repo-mirror extension under test (byte-identical to the live file). */
export const EXTENSION_URL = new URL("../../agent/extensions/agentic-team-protocol/index.ts", import.meta.url).href;
export const FIXTURE_BIN_SRC = new URL("./fixtures/eden-fixture.mjs", import.meta.url).pathname;

// Public-safe placeholder identity — never real org/user values.
export const TEST_ORG = "test-org";
export const TEST_USER = "test-user";
export const TEST_WS = "test-ws";
export const TEST_GOAL = "11111111-1111-4111-8111-111111111111";

/** Fixed base timestamp (unix seconds) for deterministic fixture ordering. */
export const FIXTURE_BASE_TS = 1_760_000_000;

// ---------------------------------------------------------------------------
// Real-child-process exec seam — what the mock pi.exec calls through to.
// ---------------------------------------------------------------------------

/** Run a real child process; resolve {code, stdout, stderr} never rejects. */
export function execRun(cmd: string, args: string[], opts: any = {}): Promise<any> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{
				timeout: opts.timeout ?? 30_000,
				maxBuffer: 32 * 1024 * 1024,
				cwd: opts.cwd,
				env: opts.env ? { ...process.env, ...opts.env } : undefined,
				killSignal: opts.killSignal,
			} as any,
			(err: any, stdout: string, stderr: string) => {
				let code = 0;
				if (err) {
					if (typeof err.code === "number") code = err.code;
					else if (err.killed) code = 124; // timeout
					else code = 127; // ENOENT and friends
				}
				resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
			},
		);
	});
}

// ---------------------------------------------------------------------------
// Mock pi / ctx / theme
// ---------------------------------------------------------------------------

export function createMockPi({ exec = execRun }: { exec?: Function } = {}) {
	const tools = new Map();
	const commands = new Map();
	const listeners = new Map();
	const pi: any = {
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		on: (event: string, handler: Function) => {
			const arr = listeners.get(event) ?? [];
			arr.push(handler);
			listeners.set(event, arr);
		},
		exec: (cmd: string, args: string[], opts?: any) => exec(cmd, args, opts ?? {}),
		sentUserMessages: [] as { content: any; opts: any }[],
		appendEntries: [] as { customType: string; data: any }[],
		sendUserMessage: (content: any, opts?: any) => {
			pi.sentUserMessages.push({ content, opts });
		},
		appendEntry: (customType: string, data?: any) => {
			pi.appendEntries.push({ customType, data });
		},
	};
	/** Fire registered handlers, e.g. __emit("session_start", event, ctx). */
	pi.__emit = async (event: string, ...args: any[]) => {
		for (const h of listeners.get(event) ?? []) await h(...args);
	};
	return { pi, tools, commands, listeners };
}

export function createMockCtx(overrides: any = {}) {
	const captured: any = { notify: [], setWidget: {}, setStatus: {}, custom: [], customDone: false };
	const theme = overrides.theme ?? createTheme(overrides.themeMode ?? "ansi");
	const ctx: any = {
		cwd: overrides.cwd ?? tmpdir(),
		mode: overrides.mode ?? "tui",
		hasUI: overrides.hasUI ?? true,
		sessionManager: overrides.sessionManager ?? {},
		ui: {
			theme,
			notify: (msg: string, level?: string) => captured.notify.push({ msg, level }),
			setWidget: (name: string, lines: string[] | undefined) => {
				captured.setWidget[name] = lines;
			},
			setStatus: (name: string, text: string | undefined) => {
				captured.setStatus[name] = text;
			},
			custom: async (factory?: any) => {
				// capture the overlay factory result like a real TUI would, so
				// /team-board overlay content and esc handling are assertable
				const overlay = factory ? factory(null, theme, null, () => { captured.customDone = true; }) : undefined;
				captured.custom.push(overlay);
				return overlay;
			},
		},
	};
	return { ctx, captured, theme };
}

const ANSI_BY_COLOR: Record<string, string> = {
	accent: "36",
	error: "31",
	warning: "33",
	success: "32",
	muted: "90",
	dim: "2",
	toolTitle: "95",
};

/**
 * Mock theme. `ansi` mode emits real SGR codes (pi-tui's visibleWidth strips
 * ANSI, so board-width tests stay correct); `passthrough` returns text bare.
 */
export function createTheme(mode: "ansi" | "passthrough" = "ansi") {
	return {
		__mode: mode,
		fg: (color: string, text: string) =>
			mode === "passthrough" ? text : `\x1b[${ANSI_BY_COLOR[color] ?? "36"}m${text}\x1b[0m`,
		bold: (text: string) => (mode === "passthrough" ? text : `\x1b[1m${text}\x1b[0m`),
	};
}

export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------------------
// Environment control (the extension resolves identity/workspace/db from env)
// ---------------------------------------------------------------------------

/** Snapshot current env keys, apply overrides, run fn, restore in finally. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
	const had = new Map<string, string | undefined>();
	for (const k of Object.keys(vars)) had.set(k, process.env[k]);
	try {
		for (const [k, v] of Object.entries(vars)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		return await fn();
	} finally {
		for (const [k, v] of had) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** Standard identity env for tool-level tests. EDEN_MEMORY_DB/BIN added per test. */
export function testEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		EDEN_ORG_ID: TEST_ORG,
		USER_ID: TEST_USER,
		ATP_WORKSPACE_ID: TEST_WS,
		...extra,
	};
}

// ---------------------------------------------------------------------------
// Fixture DB (mirrors the real eden-memory `memories` columns fetchGoals uses)
// ---------------------------------------------------------------------------

const FIXTURE_SCHEMA = `
CREATE TABLE memories (
	id TEXT PRIMARY KEY,
	content TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	metadata TEXT NOT NULL DEFAULT '{}',
	deleted_at INTEGER DEFAULT 0,
	agent_id TEXT DEFAULT '',
	user_id TEXT DEFAULT '',
	workspace_id TEXT DEFAULT '',
	org_id TEXT DEFAULT '',
	expires_at INTEGER DEFAULT 0
);
`;

let fixtureSeq = 0;

export interface FixtureRecordInput {
	id?: string;
	goalId?: string;
	stage?: string;
	owner?: string;
	recordType?: string;
	status?: string;
	body?: string;
	agentId?: string;
	createdAt?: number;
	workspaceId?: string;
	orgId?: string;
	metadata?: Record<string, unknown>;
	content?: string;
	deleted?: boolean;
}

/**
 * Build one fixture row exactly the way team_remember writes records:
 * identity line `Goal: … | Stage: … | Owner: …` + structured metadata.
 */
export function fixtureRecord(input: FixtureRecordInput = {}): Record<string, unknown> {
	fixtureSeq += 1;
	const goalId = input.goalId ?? TEST_GOAL;
	const stage = input.stage ?? "action";
	const owner = input.owner ?? "builder";
	const recordType = input.recordType ?? "action_record";
	const status = input.status ?? "in_progress";
	const createdAt = input.createdAt ?? FIXTURE_BASE_TS + fixtureSeq;
	const identity = `Goal: ${goalId} | Stage: ${stage} | Owner: ${owner}`;
	const metadata = {
		goal_id: goalId,
		stage,
		owner_role: owner,
		record_type: recordType,
		status,
		protocol: "agentic-team-protocol",
		...(input.metadata ?? {}),
	};
	return {
		id: input.id ?? `00000000-0000-4000-8000-${String(fixtureSeq).padStart(12, "0")}`,
		agent_id: input.agentId ?? owner,
		content: input.content ?? `${identity}\n${input.body ?? ""}`,
		created_at: createdAt,
		updated_at: createdAt,
		metadata: JSON.stringify(metadata),
		deleted_at: input.deleted ? 1 : 0,
		workspace_id: input.workspaceId ?? TEST_WS,
		org_id: input.orgId ?? TEST_ORG,
	};
}

/** Create a scratch SQLite DB with the eden-memory schema + fixture rows. */
export function createFixtureDb(records: Record<string, unknown>[] = []): { dbPath: string; dispose: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "atp-fixture-db-"));
	const dbPath = join(dir, "fixture.db");
	const db = new DatabaseSync(dbPath);
	try {
		db.exec(FIXTURE_SCHEMA);
		const ins = db.prepare(
			`INSERT INTO memories (id, content, created_at, updated_at, metadata, deleted_at, agent_id, user_id, workspace_id, org_id, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		);
		for (const r of records) {
			ins.run(
				r.id as string,
				r.content as string,
				r.created_at as number,
				r.updated_at as number,
				r.metadata as string,
				(r.deleted_at as number) ?? 0,
				r.agent_id as string,
				TEST_USER,
				r.workspace_id as string,
				r.org_id as string,
			);
		}
	} finally {
		db.close();
	}
	return { dbPath, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Stub eden-memory CLI binary
// ---------------------------------------------------------------------------

/** Install the fixture CLI (copy + chmod) into a fresh temp dir. */
export function installFixtureBin(): { binPath: string; logPath: string; statePath: string; dbPath: string; dir: string; dispose: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "atp-fixture-bin-"));
	const binPath = join(dir, "eden-fixture");
	copyFileSync(FIXTURE_BIN_SRC, binPath);
	chmodSync(binPath, 0o755);
	return {
		binPath,
		logPath: join(dir, "argv.log"),
		statePath: join(dir, "state"),
		dbPath: join(dir, "fixture-cli.db"),
		dir,
		dispose: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** Parse the fixture argv log (JSON lines: {argv, cwd}). */
export async function readArgvLog(logPath: string): Promise<{ argv: string[]; cwd: string }[]> {
	const { readFileSync } = await import("node:fs");
	try {
		return readFileSync(logPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Extension loading
// ---------------------------------------------------------------------------

let extModule: Promise<any> | null = null;
/** Import the extension module once per test-file process (module state shared). */
export function importExtension(): Promise<any> {
	extModule ??= import(EXTENSION_URL);
	return extModule;
}

/** Load the extension through the mock pi and return tools/commands maps. */
export async function loadExtension(opts: { exec?: Function } = {}) {
	const mod = await importExtension();
	const { pi, tools, commands, listeners } = createMockPi(opts);
	mod.default(pi);
	return { pi, tools, commands, listeners, mod };
}
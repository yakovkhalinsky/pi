/**
 * C7 — live widget + poller: tailJsonl incremental parsing, session-entry
 * activity extraction, manifest polling, subagent row formatting, and the
 * composed widget (goal board + agent rows + needs-you + steer queue + footer).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
	TEST_GOAL,
	createFixtureDb,
	createMockCtx,
	fixtureRecord,
	importExtension,
	installFixtureBin,
	loadExtension,
	testEnv,
	withEnv,
} from "./harness.ts";

const mod = await importExtension();
const NOW = Date.now();
const ansi = createThemeOfExtension();
function createThemeOfExtension() {
	// local passthrough theme (harness createTheme works too; keep it local for clarity)
	return { fg: (_c: string, t: string) => t, bold: (t: string) => t };
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("C7-4: tailJsonl — incremental, partial-line-safe, garbage-tolerant", () => {
	it("returns only complete lines; holds the partial remainder across reads", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atp-tail-"));
		try {
			const file = join(dir, "m.jsonl");
			const state = { offset: 0, remainder: "" };
			writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":'); // last line partial
			assert.deepEqual(mod.tailJsonl(file, state), [{ n: 1 }, { n: 2 }]);
			assert.equal(state.remainder, '{"n":');
			appendFileSync(file, '3}\nnot json at all\n{"n":5}\n');
			assert.deepEqual(mod.tailJsonl(file, state), [{ n: 3, }, { n: 5 }], "partial completed; garbage skipped");
			assert.equal(state.remainder, "");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("handles truncation/rotation by restarting from the new content", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atp-tail-trunc-"));
		try {
			const file = join(dir, "m.jsonl");
			const state = { offset: 0, remainder: "" };
			writeFileSync(file, '{"old":1}\n{"old":2}\n');
			mod.tailJsonl(file, state);
			assert.ok(state.offset > 0);
			writeFileSync(file, '{"new":9}\n'); // truncated
			assert.deepEqual(mod.tailJsonl(file, state), [{ new: 9 }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("C7-5: describeSessionEntry derives turns/activity", () => {
	it("assistant toolCall → '→ <tool>' (1 turn)", () => {
		assert.deepEqual(
			mod.describeSessionEntry({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hmm" }, { type: "toolCall", name: "edit" }] } }),
			{ turns: 1, activity: "→ edit" },
		);
	});
	it("assistant text → clipped text activity", () => {
		const d = mod.describeSessionEntry({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "word ".repeat(40) }] } })!;
		assert.equal(d.turns, 1);
		assert.ok(d.activity.length <= 71, `clipped to 70 + ellipsis, got ${d.activity.length}`);
		assert.ok(d.activity.startsWith("word"));
	});
	it("toolResult → '<tool> ✓/✗' (0 turns)", () => {
		assert.deepEqual(mod.describeSessionEntry({ type: "message", message: { role: "toolResult", toolName: "edit", isError: false } }), { turns: 0, activity: "edit ✓" });
		assert.deepEqual(mod.describeSessionEntry({ type: "message", message: { role: "toolResult", toolName: "bash", isError: true } }), { turns: 0, activity: "bash ✗" });
	});
	it("non-message entries → null", () => {
		assert.equal(mod.describeSessionEntry({ type: "other" }), null);
		assert.equal(mod.describeSessionEntry(null), null);
	});
});

describe("C7-6: pollManifest + pollChildSessions drive the live rows", () => {
	const dir = mkdtempSync(join(tmpdir(), "atp-poll-"));
	const manifest = join(dir, "manifest.jsonl");
	const session = join(dir, "child.jsonl");
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("started record creates a running row; re-poll without new data is a no-op", async () => {
		writeFileSync(manifest, JSON.stringify({ type: "started", episodeId: "ep1", sessionId: "s1", agent: "builder", sessionFile: session, startedAt: new Date(NOW - 6 * 60_000).toISOString() }) + "\n");
		assert.equal(mod.pollManifest(manifest), true, "changed on first poll");
		const rows = mod.sortedSubagentRows();
		assert.equal(rows.length, 1);
		assert.equal(rows[0].agent, "builder");
		assert.equal(rows[0].status, "running");
		assert.equal(mod.pollManifest(manifest), false, "no new records → unchanged");
	});

	it("child session entries accumulate turns + last activity", async () => {
		writeFileSync(
			session,
			[
				JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "edit" }] } }),
				JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "edit", isError: false } }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "edited runner.ts" }] } }),
			].join("\n") + "\n",
		);
		mod.pollChildSessions();
		const row = mod.sortedSubagentRows()[0];
		assert.equal(row.turns, 2);
		assert.equal(row.lastActivity, "edited runner.ts");
		// incremental: appending more entries only counts the new ones
		appendFileSync(session, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }) + "\n");
		mod.pollChildSessions();
		assert.equal(mod.sortedSubagentRows()[0].turns, 3);
	});

	it("finished record flips status and stops tailing the child", async () => {
		appendFileSync(manifest, JSON.stringify({ type: "finished", episodeId: "ep1", status: "completed", finishedAt: new Date().toISOString() }) + "\n");
		assert.equal(mod.pollManifest(manifest), true);
		const row = mod.sortedSubagentRows()[0];
		assert.equal(row.status, "completed");
		assert.ok(row.finishedAt);
		const turnsBefore = row.turns;
		appendFileSync(session, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "edit" }] } }) + "\n");
		mod.pollChildSessions();
		assert.equal(mod.sortedSubagentRows()[0].turns, turnsBefore, "finished rows are no longer tailed");
	});
});

describe("C7-2/C7-3: subagent row formatting + elapsed", () => {
	it("fmtElapsed buckets", () => {
		assert.equal(mod.fmtElapsed(59_000), "59s");
		assert.equal(mod.fmtElapsed(61_000), "1m:01");
		assert.equal(mod.fmtElapsed(6 * 60_000), "6m");
		assert.equal(mod.fmtElapsed(2 * 3600_000), "2h00m");
	});
	it("running row: ● agent · activity · N turns · elapsed", () => {
		const line = strip(mod.formatSubagentRow({ fg: (_c, t) => t, bold: (t) => t } as any, {
			episodeId: "e", sessionId: "s", agent: "builder", parentEpisodeId: null, status: "running",
			startedAt: NOW - 6 * 60_000, turns: 14, lastActivity: "→ edit runner.ts",
		}));
		assert.equal(line, "● builder · → edit runner.ts · 14 turns · 6m");
	});
	it("terminal rows: ✓ completed / ✗ failed / ⏹ aborted", () => {
		const base = { episodeId: "e", sessionId: "s", agent: "builder", parentEpisodeId: null, startedAt: NOW - 12_000, turns: 3, finishedAt: NOW } as const;
		assert.equal(strip(mod.formatSubagentRow({ fg: (_c, t) => t, bold: (t) => t } as any, { ...base, status: "completed" })), "✓ builder · completed · 3 turns · 12s");
		assert.ok(strip(mod.formatSubagentRow({ fg: (_c, t) => t, bold: (t) => t } as any, { ...base, status: "failed" })).includes("✗ builder"));
		assert.ok(strip(mod.formatSubagentRow({ fg: (_c, t) => t, bold: (t) => t } as any, { ...base, status: "aborted" })).includes("⏹ builder"));
	});
	it("nested children are indented under a present parent", async () => {
		const { pi } = await loadExtension();
		const dir = mkdtempSync(join(tmpdir(), "atp-nest-"));
		try {
			const manifest = join(dir, "m.jsonl");
			writeFileSync(
				manifest,
				[
					JSON.stringify({ type: "started", episodeId: "ep-parent", agent: "dispatcher" }),
					JSON.stringify({ type: "started", episodeId: "ep-child", agent: "builder", parentEpisodeId: "ep-parent" }),
				].join("\n") + "\n",
			);
			mod.pollManifest(manifest);
			const rows = mod.sortedSubagentRows();
			const child = rows.find((r: any) => r.episodeId === "ep-child")!;
			const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
			assert.ok(mod.formatSubagentRow(theme as any, child).startsWith("  ↳ "), "child indented");
			const parent = rows.find((r: any) => r.episodeId === "ep-parent")!;
			assert.ok(!mod.formatSubagentRow(theme as any, parent).startsWith("  ↳ "), "parent not indented");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			pi.__emit("session_shutdown"); // clear shared subagentRows
		}
	});
});

describe("C7-1: renderWidget composes board + agent rows + needs-you + steers + footer", () => {
	const db1 = createFixtureDb([
		fixtureRecord({ goalId: TEST_GOAL, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", body: '{"title":"Widget Goal"}', createdAt: 1_760_000_001 }),
		fixtureRecord({ goalId: TEST_GOAL, recordType: "pending_authorisation", stage: "pending_authorisation", owner: "runtime", status: "pending_authorisation", body: "approve the deploy?", createdAt: 1_760_000_002 }),
		fixtureRecord({ recordType: "steer_request", stage: "action", owner: "builder", status: "queued", metadata: { record_type: "steer_request", status: "queued", target_role: "builder", steer_message: "use the helper", goal_id: TEST_GOAL }, createdAt: 1_760_000_003 }),
	]);
	const dbEmpty = createFixtureDb([]);
	const { binPath, dispose: disposeBin } = installFixtureBin();
	let ctxOf = () => createMockCtx();

	after(() => {
		disposeBin();
		db1.dispose();
		dbEmpty.dispose();
	});

	it("full widget: board rows, live agent row, needs-you, steer line, footer summary", async () => {
		const { pi } = await loadExtension();
		const dir = mkdtempSync(join(tmpdir(), "atp-widget-"));
		try {
			const manifest = join(dir, "m.jsonl");
			writeFileSync(manifest, JSON.stringify({ type: "started", episodeId: "ep-w", agent: "builder", startedAt: new Date().toISOString() }) + "\n");
			mod.pollManifest(manifest);
			await withEnv(testEnv({ EDEN_MEMORY_DB: db1.dbPath, EDEN_MEMORY_BIN: binPath }), async () => {
				const { ctx, captured } = ctxOf();
				await mod.renderWidget(pi, ctx);
				const lines = (captured.setWidget["atp-board"] ?? []).map(strip);
				const joined = lines.join("\n");
				const expect = (needle: string, what: string) => assert.ok(joined.includes(needle), `${what}: ${JSON.stringify(joined.slice(0, 400))}`);
				expect("Widget Goal", "goal row present (title)");
				expect("● builder", "live agent row");
				expect("↪ steer→builder", "queued steer line");
				expect("⚠ Needs you (1)", "needs-you section");
				expect("approve the deploy?", "question surfaced");
				assert.equal(captured.setStatus["atp"], "Team 1 active · 1 pending", "footer summary");
			});
			// agents-only fallback: empty goal DB, live rows remain
			await withEnv(testEnv({ EDEN_MEMORY_DB: dbEmpty.dbPath, EDEN_MEMORY_BIN: binPath }), async () => {
				const { ctx, captured } = ctxOf();
				await mod.renderWidget(pi, ctx);
				const joined = (captured.setWidget["atp-board"] ?? []).map(strip).join("\n");
				assert.ok(joined.includes("● builder"), "agent rows shown without goals");
				assert.ok(!joined.includes("STATE"), "no board header without goals");
				assert.equal(captured.setStatus["atp"], "Team 1 active", "footer omits the pending part when zero");
			});
			// nothing live → widget cleared entirely
			await pi.__emit("session_shutdown");
			await withEnv(testEnv({ EDEN_MEMORY_DB: dbEmpty.dbPath, EDEN_MEMORY_BIN: binPath }), async () => {
				const { ctx, captured } = ctxOf();
				await mod.renderWidget(pi, ctx);
				assert.equal(captured.setWidget["atp-board"], undefined, "widget removed");
				assert.equal(captured.setStatus["atp"], undefined, "status cleared");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("C7-1b: running agents attach to their goal (de-duplicated agent UI)", () => {
	const { binPath, dispose: disposeBin } = installFixtureBin();
	after(() => disposeBin());

	function seedRunning(dir: string, episodeId: string, agent: string, activity: string, opts: { sessionFile?: string; parentEpisodeId?: string } = {}) {
		const manifest = join(dir, "m.jsonl");
		appendFileSync(
			manifest,
			JSON.stringify({ type: "started", episodeId, agent, sessionFile: opts.sessionFile, parentEpisodeId: opts.parentEpisodeId, startedAt: new Date(Date.now() - 6 * 60_000).toISOString() }) + "\n",
		);
		mod.pollManifest(manifest);
		if (opts.sessionFile) {
			writeFileSync(opts.sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: activity.replace("→ ", "") }] } }) + "\n");
			mod.pollChildSessions();
		}
	}

	it("attaches a running agent under its goal as a name-free activity line", async () => {
		const db = createFixtureDb([
			fixtureRecord({ goalId: TEST_GOAL, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", body: '{"title":"Attach Goal"}', createdAt: 1_760_000_001 }),
			fixtureRecord({ goalId: TEST_GOAL, recordType: "action_record", stage: "action", owner: "builder", status: "in_progress", createdAt: 1_760_000_002 }),
		]);
		const { pi } = await loadExtension();
		const dir = mkdtempSync(join(tmpdir(), "atp-attach-"));
		try {
			seedRunning(dir, "ep-att", "builder", "→ edit", { sessionFile: join(dir, "c.jsonl") });
			await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath, EDEN_MEMORY_BIN: binPath }), async () => {
				const { ctx, captured } = createMockCtx();
				await mod.renderWidget(pi, ctx);
				const lines = (captured.setWidget["atp-board"] ?? []).map(strip);
				const joined = lines.join("\n");
				assert.ok(joined.includes("Attach Goal"), "goal row");
				assert.ok(joined.includes("  ● → edit · 1 turns · 6m"), "attached activity line, no role name");
				assert.ok(!joined.includes("● builder"), "role name not repeated under its own goal row");
				assert.equal(captured.setStatus["atp"], "Team 1 active");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
			db.dispose();
			pi.__emit("session_shutdown");
		}
	});

	it("in-flight hand-off: the incoming role's agent attaches under nextOwner", async () => {
		// mid-flight hand-off WITHOUT archival: goal stays continueable, nextOwner shows
		const db = createFixtureDb([
			fixtureRecord({ goalId: TEST_GOAL, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", createdAt: 1_760_000_001 }),
			fixtureRecord({ goalId: TEST_GOAL, recordType: "action_record", stage: "context_gathering", owner: "researcher", status: "completed", createdAt: 1_760_000_002 }),
			fixtureRecord({ goalId: TEST_GOAL, recordType: "hand_off_record", stage: "hand_off_or_closure", owner: "researcher", createdAt: 1_760_000_003, metadata: { next_role: "builder" } }),
		]);
		const { pi } = await loadExtension();
		const dir = mkdtempSync(join(tmpdir(), "atp-nextown-"));
		try {
			seedRunning(dir, "ep-next", "builder", "→ edit", { sessionFile: join(dir, "c.jsonl") });
			await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath, EDEN_MEMORY_BIN: binPath }), async () => {
				const { ctx, captured } = createMockCtx();
				await mod.renderWidget(pi, ctx);
				const joined = (captured.setWidget["atp-board"] ?? []).map(strip).join("\n");
				assert.ok(joined.includes("→ builder"), "board shows incoming owner");
				assert.ok(joined.includes("  ● → edit"), "agent attaches under the goal it is taking over");
				assert.ok(!joined.includes("● builder"), "no standalone duplicate");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
			db.dispose();
			pi.__emit("session_shutdown");
		}
	});

	it("finished runs are dropped — the board's goal row carries terminal state", async () => {
		const db = createFixtureDb([
			fixtureRecord({ goalId: TEST_GOAL, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", body: '{"title":"Done Goal"}', createdAt: 1_760_000_001 }),
		]);
		const { pi } = await loadExtension();
		const dir = mkdtempSync(join(tmpdir(), "atp-fin-"));
		try {
			const manifest = join(dir, "m.jsonl");
			writeFileSync(manifest, JSON.stringify({ type: "started", episodeId: "ep-fin", agent: "builder", startedAt: new Date().toISOString() }) + "\n");
			mod.pollManifest(manifest);
			appendFileSync(manifest, JSON.stringify({ type: "finished", episodeId: "ep-fin-x", status: "completed" }) + "\n");
			writeFileSync(manifest, JSON.stringify({ type: "started", episodeId: "ep-fin", agent: "builder", startedAt: new Date().toISOString() }) + "\n" + JSON.stringify({ type: "finished", episodeId: "ep-fin", status: "completed", finishedAt: new Date().toISOString() }) + "\n");
			mod.pollManifest(manifest);
			await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath, EDEN_MEMORY_BIN: binPath }), async () => {
				const { ctx, captured } = createMockCtx();
				await mod.renderWidget(pi, ctx);
				const joined = (captured.setWidget["atp-board"] ?? []).map(strip).join("\n");
				assert.ok(joined.includes("Done Goal"), "board still renders");
				assert.ok(!joined.includes("✓ builder"), "no terminal agent row under the board");
				assert.ok(!joined.includes("completed"), "no completed agent line");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
			db.dispose();
			pi.__emit("session_shutdown");
		}
	});

	it("ambiguous role (same role owning several active goals) stays standalone with its name", async () => {
		const goalB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const db = createFixtureDb([
			fixtureRecord({ goalId: TEST_GOAL, recordType: "action_record", owner: "builder", createdAt: 1_760_000_001 }),
			fixtureRecord({ goalId: goalB, recordType: "action_record", owner: "builder", createdAt: 1_760_000_002 }),
		]);
		const { pi } = await loadExtension();
		const dir = mkdtempSync(join(tmpdir(), "atp-ambig-"));
		try {
			seedRunning(dir, "ep-amb", "builder", "→ edit", { sessionFile: join(dir, "c.jsonl") });
			await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath, EDEN_MEMORY_BIN: binPath }), async () => {
				const { ctx, captured } = createMockCtx();
				await mod.renderWidget(pi, ctx);
				const joined = (captured.setWidget["atp-board"] ?? []).map(strip).join("\n");
				assert.ok(joined.includes("● builder · → edit"), "standalone row keeps the role name (no silent binding)");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
			db.dispose();
			pi.__emit("session_shutdown");
		}
	});

	it("nested child runs indent under the parent's activity line", async () => {
		const db = createFixtureDb([
			fixtureRecord({ goalId: TEST_GOAL, recordType: "action_record", owner: "builder", createdAt: 1_760_000_001 }),
		]);
		const { pi } = await loadExtension();
		const dir = mkdtempSync(join(tmpdir(), "atp-nestw-"));
		try {
			seedRunning(dir, "ep-par", "builder", "→ edit", { sessionFile: join(dir, "p.jsonl") });
			seedRunning(dir, "ep-chi", "builder", "→ bash", { sessionFile: join(dir, "c.jsonl"), parentEpisodeId: "ep-par" });
			await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath, EDEN_MEMORY_BIN: binPath }), async () => {
				const { ctx, captured } = createMockCtx();
				await mod.renderWidget(pi, ctx);
				const lines = (captured.setWidget["atp-board"] ?? []).map(strip);
				const joined = lines.join("\n");
				assert.ok(joined.includes("  ● → edit"), "parent activity line");
				assert.ok(joined.includes("    ↳ → bash"), "child indented under parent");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
			db.dispose();
			pi.__emit("session_shutdown");
		}
	});

	it("more than 6 live agent lines collapse into an overflow note", async () => {
		const db = createFixtureDb([
			fixtureRecord({ goalId: TEST_GOAL, recordType: "action_record", owner: "builder", createdAt: 1_760_000_001 }),
		]);
		const { pi } = await loadExtension();
		const dir = mkdtempSync(join(tmpdir(), "atp-budg-"));
		try {
			for (let i = 0; i < 7; i++) seedRunning(dir, `ep-b${i}`, `role${i}`, "→ tool");
			await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath, EDEN_MEMORY_BIN: binPath }), async () => {
				const { ctx, captured } = createMockCtx();
				await mod.renderWidget(pi, ctx);
				const joined = (captured.setWidget["atp-board"] ?? []).map(strip).join("\n");
				assert.ok(joined.includes("…+1 more running agent"), "overflow note");
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
			db.dispose();
			pi.__emit("session_shutdown");
		}
	});
});
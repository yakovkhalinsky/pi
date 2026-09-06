/**
 * C8 — steer UX: themeless line format, team_steer tool write + error card,
 * /steer command resolution (ambiguous prefix refusal, role validation,
 * auto-scoping), goal-scoped delivery (no cross-goal leaks), consume-once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	TEST_GOAL,
	createFixtureDb,
	createMockCtx,
	createTheme,
	fixtureRecord,
	importExtension,
	installFixtureBin,
	loadExtension,
	readArgvLog,
	stripAnsi,
	testEnv,
	withEnv,
} from "./harness.ts";

const mod = await importExtension();
const { tools, commands } = await loadExtension();
const ansi = createTheme("ansi");
const GOAL_A = TEST_GOAL;
const GOAL_B = "11111122-2222-4222-8222-222222222222"; // shares the "111111" prefix with GOAL_A

function steerRow(goalId: string, target: string, message: string, createdAt: number) {
	return fixtureRecord({
		goalId,
		recordType: "steer_request",
		stage: "action",
		owner: target,
		status: "queued",
		metadata: { record_type: "steer_request", status: "queued", target_role: target, steer_message: message, goal_id: goalId, source: "test" },
		createdAt,
	});
}

describe("C8-1: themelessSteerLine format", () => {
	it("goal-scoped and unscoped variants", () => {
		assert.equal(mod.themelessSteerLine(GOAL_A, "builder", "use the helper"), `⚠ STEERING for builder (goal ${mod.displayGoal(GOAL_A)}): use the helper`);
		assert.equal(mod.themelessSteerLine("", "runtime", "roll back"), "⚠ STEERING for runtime: roll back");
	});
});

describe("C8-6: team_steer tool", () => {
	it("writes a queued steer_request with target/role/source metadata", async () => {
		const db = createFixtureDb([]);
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath }), async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				const result = await tools.get("team_steer")!.execute("c86", { role: "builder", message: "use the helper", goal_id: GOAL_A }, undefined, () => {}, ctx);
				assert.equal(result.details.ok, true);
				assert.match(result.details.recordId, /^[0-9a-f-]{36}$/);
				assert.ok(result.content[0].text.includes("Steer queued for builder"));

				const calls = await readArgvLog(logPath);
				const rememberCall = calls.find((c) => c.argv.includes("remember"))!;
				const md = JSON.parse(rememberCall.argv[rememberCall.argv.indexOf("--metadata") + 1]);
				assert.equal(md.record_type, "steer_request");
				assert.equal(md.status, "queued");
				assert.equal(md.target_role, "builder");
				assert.equal(md.steer_message, "use the helper");
				assert.equal(md.source, "team_steer");
				assert.equal(md.goal_id, GOAL_A);
			});
		} finally {
			dispose();
			db.dispose();
		}
	});

	it("renderResult: error path and success card", () => {
		const err = tools.get("team_steer")!.renderResult({ content: [], details: { ok: false, error: "boom" } }, {}, ansi, createMockCtx().ctx);
		assert.ok(stripAnsi(err.render(200).join("\n")).includes("team_steer error: boom"));
		const ok = tools.get("team_steer")!.renderResult({ content: [], details: { ok: true, recordId: "abcd-1234", role: "builder" } }, {}, ansi, createMockCtx().ctx);
		assert.ok(stripAnsi(ok.render(200).join("\n")).includes("↪ steer queued builder"));
	});
});

describe("C8-2/C8-3: /steer command resolution", () => {
	it("ambiguous goal-id prefix is refused — never silently picks the first match", async () => {
		const db = createFixtureDb([
			fixtureRecord({ goalId: GOAL_A, recordType: "goal_record", owner: "dispatcher", body: '{"title":"Goal A"}', createdAt: 1_760_000_001 }),
			fixtureRecord({ goalId: GOAL_B, recordType: "goal_record", owner: "dispatcher", body: '{"title":"Goal B"}', createdAt: 1_760_000_002 }),
		]);
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath }), async () => {
				const { commands } = await loadExtension();
				const { ctx, captured } = createMockCtx();
				await commands.get("steer")!.handler("111111 builder do x", ctx);
				const last = captured.notify.at(-1);
				assert.equal(last.level, "error");
				assert.ok(last.msg.includes("matches multiple goals"), "refuses ambiguity");
				assert.ok(last.msg.includes("Goal A") && last.msg.includes("Goal B"), "names both matches");
				assert.ok(last.msg.includes("type more of the goal id"));
				assert.equal((await readArgvLog(logPath)).length, 0, "nothing written on refusal");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});

	it("full goal id + valid role writes the steer via /steer source", async () => {
		const db = createFixtureDb([
			fixtureRecord({ goalId: GOAL_A, recordType: "goal_record", owner: "dispatcher", body: '{"title":"Goal A"}', createdAt: 1_760_000_001 }),
		]);
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath }), async () => {
				const { commands } = await loadExtension();
				const { ctx, captured } = createMockCtx();
				await commands.get("steer")!.handler(`${GOAL_A} builder use the helper`, ctx);
				const last = captured.notify.at(-1);
				assert.equal(last.level, "info");
				assert.ok(last.msg.includes("↪ steer queued for builder"), "confirmation");
				const md = JSON.parse((await readArgvLog(logPath)).find((c) => c.argv.includes("remember"))!.argv[
					(await readArgvLog(logPath)).find((c) => c.argv.includes("remember"))!.argv.indexOf("--metadata") + 1
				]);
				assert.equal(md.source, "/steer");
				assert.equal(md.target_role, "builder");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});

	it("unknown role (as goal target), usage, and empty message are refused with guidance", async () => {
		// a matched goal is required before the role-position check fires
		const db = createFixtureDb([
			fixtureRecord({ goalId: GOAL_A, recordType: "goal_record", owner: "dispatcher", body: '{"title":"Goal A"}', createdAt: 1_760_000_001 }),
		]);
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath }), async () => {
				const { ctx, captured } = createMockCtx();
				await commands.get("steer")!.handler("builder", ctx);
				assert.ok(captured.notify.at(-1).msg.includes("Usage: /steer"));
				await commands.get("steer")!.handler(`${GOAL_A} wizard msg`, ctx);
				assert.ok(captured.notify.at(-1).msg.includes("unknown role 'wizard'"));
				await commands.get("steer")!.handler(`${GOAL_A} builder`, ctx);
				assert.ok(captured.notify.at(-1).msg.includes("message is empty"));
				// unknown FIRST token with no goal match → the combined not-a-role/not-a-goal error
				await commands.get("steer")!.handler("wizard msg", ctx);
				assert.ok(captured.notify.at(-1).msg.includes("is not a role") && captured.notify.at(-1).msg.includes("or a known goal id"));
				assert.equal((await readArgvLog(logPath)).filter((c) => c.argv.includes("remember")).length, 0, "nothing written on refusals");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});

	it("no goal given + exactly one active goal → auto-scoped to it", async () => {
		const db = createFixtureDb([
			fixtureRecord({ goalId: GOAL_A, recordType: "goal_record", owner: "dispatcher", body: '{"title":"Goal A"}', createdAt: 1_760_000_001 }),
			fixtureRecord({ goalId: GOAL_A, recordType: "action_record", owner: "builder", createdAt: 1_760_000_002 }),
		]);
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath }), async () => {
				const { commands } = await loadExtension();
				const { ctx, captured } = createMockCtx();
				await commands.get("steer")!.handler("builder keep it small", ctx);
				assert.ok(captured.notify.at(-1).msg.includes(`steer queued for builder on ${mod.displayGoal(GOAL_A)}`));
				const call = (await readArgvLog(logPath)).find((c) => c.argv.includes("remember"))!;
				const md = JSON.parse(call.argv[call.argv.indexOf("--metadata") + 1]);
				assert.equal(md.goal_id, GOAL_A, "auto-scoped to the single active goal");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});

	it("no goal given + multiple active goals → refused, asks for a goal id", async () => {
		const db = createFixtureDb([
			fixtureRecord({ goalId: GOAL_A, recordType: "goal_record", owner: "dispatcher", createdAt: 1_760_000_001 }),
			fixtureRecord({ goalId: GOAL_B, recordType: "goal_record", owner: "dispatcher", createdAt: 1_760_000_002 }),
		]);
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath }), async () => {
				const { commands } = await loadExtension();
				const { ctx, captured } = createMockCtx();
				await commands.get("steer")!.handler("builder keep it small", ctx);
				assert.ok(captured.notify.at(-1).msg.includes("multiple active goals"));
				assert.ok(captured.notify.at(-1).msg.includes("pass a goal id first"));
				assert.equal((await readArgvLog(logPath)).length, 0);
			});
		} finally {
			dispose();
			db.dispose();
		}
	});
});

describe("C8-4/C8-5: goal-scoped delivery + consume-once", () => {
	it("goal-declaring calls receive only their goal's steers plus unscoped ones", async () => {
		const db = createFixtureDb([
			steerRow(GOAL_A, "builder", "steer for goal A", 1_760_000_001),
			steerRow("", "builder", "unscoped steer", 1_760_000_002),
			steerRow(GOAL_B, "builder", "steer for goal B — must not leak", 1_760_000_003),
		]);
		const { binPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_APPLY: "1" }), async () => {
				const { pi } = await loadExtension();
				const { ctx } = createMockCtx();
				const cfg = mod.edenConfig(ctx);
				const lines = await mod.consumePendingSteers(pi, ctx, cfg, "builder", GOAL_A);
				assert.equal(lines.length, 2, "goal A steer + unscoped steer; goal B excluded");
				const joined = lines.join("\n");
				assert.ok(joined.includes("steer for goal A"));
				assert.ok(joined.includes("unscoped steer"));
				assert.ok(!joined.includes("must not leak"), "no cross-goal leak");
				pi.__emit("session_shutdown");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});

	it("goal-less calls deliver only unscoped steers — goal-scoped ones wait", async () => {
		const db = createFixtureDb([
			steerRow(GOAL_A, "builder", "scoped stays queued", 1_760_000_001),
			steerRow("", "builder", "unscoped delivers", 1_760_000_002),
		]);
		const { binPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_APPLY: "1" }), async () => {
				const { pi } = await loadExtension();
				const { ctx } = createMockCtx();
				const cfg = mod.edenConfig(ctx);
				const lines = await mod.consumePendingSteers(pi, ctx, cfg, "builder", undefined);
				assert.equal(lines.length, 1);
				assert.ok(lines[0].includes("unscoped delivers"));
				pi.__emit("session_shutdown");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});

	it("consume-once: delivery marks the record delivered; the next call returns none", async () => {
		const db = createFixtureDb([steerRow("", "builder", "deliver me once", 1_760_000_001)]);
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_APPLY: "1", EDEN_FIXTURE_LOG: logPath }), async () => {
				const { pi } = await loadExtension();
				const { ctx } = createMockCtx();
				const cfg = mod.edenConfig(ctx);
				const first = await mod.consumePendingSteers(pi, ctx, cfg, "builder", undefined);
				assert.equal(first.length, 1);
				// the edit call carried the delivered status
				const editCall = (await readArgvLog(logPath)).find((c) => c.argv.includes("edit"))!;
				assert.ok(editCall, "delivery recorded via CLI edit");
				const md = JSON.parse(editCall.argv[editCall.argv.indexOf("--metadata") + 1]);
				assert.equal(md.status, "delivered");
				assert.ok(md.delivered_at, "delivery timestamped");
				const second = await mod.consumePendingSteers(pi, ctx, cfg, "builder", undefined);
				assert.equal(second.length, 0, "already-delivered steers are not re-delivered");
				pi.__emit("session_shutdown");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});

	it("steers targeted at another role are never delivered", async () => {
		const db = createFixtureDb([steerRow(GOAL_A, "runtime", "for runtime only", 1_760_000_001)]);
		const { binPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_APPLY: "1" }), async () => {
				const { pi } = await loadExtension();
				const { ctx } = createMockCtx();
				const cfg = mod.edenConfig(ctx);
				assert.equal((await mod.consumePendingSteers(pi, ctx, cfg, "builder", GOAL_A)).length, 0);
				assert.equal((await mod.consumePendingSteers(pi, ctx, cfg, "builder", undefined)).length, 0);
				pi.__emit("session_shutdown");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});
});
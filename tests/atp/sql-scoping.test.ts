/**
 * B7 — SQL aggregate scoping: escape safety and org/workspace scoping of the
 * direct SQLite query used by team_status / /team-board / the widget.
 * Real sqlite3 CLI executes the captured SQL against a fixture DB.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	TEST_GOAL,
	TEST_ORG,
	TEST_USER,
	TEST_WS,
	createFixtureDb,
	createMockCtx,
	execRun,
	fixtureRecord,
	importExtension,
	loadExtension,
	testEnv,
	withEnv,
} from "./harness.ts";

const mod = await importExtension();

describe("B7-1: sqlEscape", () => {
	it("doubles single quotes so filters cannot break out of the SQL string", () => {
		assert.equal(mod.sqlEscape("it's"), "it''s");
		assert.equal(mod.sqlEscape("x' OR '1'='1"), "x'' OR ''1''=''1");
		assert.equal(mod.sqlEscape("plain"), "plain");
	});
});

describe("B7-2: the aggregate query is org- and workspace-scoped", () => {
	it("SQL filters org_id, workspace_id, deleted_at, and goal-bearing metadata", async () => {
		const db = createFixtureDb([fixtureRecord({})]);
		try {
			const captured: string[] = [];
			const captureExec = (cmd: string, args: string[], opts: any) => {
				if (cmd === "sqlite3") captured.push(args[args.length - 1]);
				return execRun(cmd, args, opts);
			};
			await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath }), async () => {
				const { pi } = await loadExtension({ exec: captureExec });
				const { ctx } = createMockCtx();
				const { goals } = await mod.fetchGoals(pi, ctx, undefined, {});
				assert.equal(goals.length, 1);
				const sql = captured[captured.length - 1];
				assert.ok(sql.includes(`org_id = '${TEST_ORG}'`), "org scoped");
				assert.ok(sql.includes(`workspace_id = '${TEST_WS}'`), "workspace scoped");
				assert.ok(sql.includes("deleted_at = 0"), "soft-deleted rows excluded");
				assert.ok(sql.includes("json_extract(metadata, '$.goal_id') IS NOT NULL"), "only ATP records");
				assert.ok(sql.includes("LIMIT 1000"), "bounded scan");
			});
		} finally {
			db.dispose();
		}
	});

	it("injected goal_id filter is escaped AND harmless when executed by real sqlite3", async () => {
		const db = createFixtureDb([fixtureRecord({ body: "the only record" })]);
		try {
			await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath }), async () => {
				const { pi } = await loadExtension();
				const { ctx } = createMockCtx();
				const injection = await mod.fetchGoals(pi, ctx, undefined, { goalId: "x' OR '1'='1" });
				assert.equal(injection.goals.length, 0, "injection matches nothing");
				assert.equal(injection.dbError, undefined, "query still executed cleanly");
				const control = await mod.fetchGoals(pi, ctx, undefined, { goalId: TEST_GOAL });
				assert.equal(control.goals.length, 1, "legit filter still matches");
			});
		} finally {
			db.dispose();
		}
	});
});
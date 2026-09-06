/**
 * B2-2 — DB-path probe: the extension resolves the CLI's effective db_path via
 * `health` once per session and pins --db on every subsequent CLI call, so
 * board reads and role writes land in the same file by construction.
 * Fixture bin reports db_path via EDEN_FIXTURE_DB_PATH; EDEN_MEMORY_DB unset.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	TEST_GOAL,
	createFixtureDb,
	createMockCtx,
	fixtureRecord,
	installFixtureBin,
	loadExtension,
	readArgvLog,
	testEnv,
	withEnv,
} from "./harness.ts";

describe("B2-2: health probe extracts db_path once; --db pinned on every call", () => {
	it("probe runs once, then every CLI call carries --db <probed path>", async () => {
		const db = createFixtureDb([fixtureRecord({ body: "board-visible record" })]);
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_FIXTURE_LOG: logPath, EDEN_FIXTURE_DB_PATH: db.dbPath }), async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();

				// 1) first tool call triggers the probe (health), then uses the probed path
				const status = await tools.get("team_status")!.execute("b22a", {}, undefined, () => {}, ctx);
				assert.equal(status.details.count, 1, "board read landed in the probed DB file");

				// 2) a write pins --db to the same probed path
				const remember = await tools.get("team_remember")!.execute(
					"b22b",
					{ agent_id: "builder", goal_id: TEST_GOAL, stage: "action", owner_role: "builder", body: "x" },
					undefined,
					() => {},
					ctx,
				);
				assert.ok(remember.details.recordId, "write succeeded");

				// write side: --db pinned to the probed path (read side already proven:
				// the board read above landed in the probed DB file)
				const calls = await readArgvLog(logPath);
				const healthCalls = calls.filter((c) => c.argv.includes("health"));
				assert.equal(healthCalls.length, 1, "probed exactly once per session");
				assert.deepEqual(healthCalls[0].argv, ["health"], "probe is a bare health call (no --db yet)");

				const rememberCalls = calls.filter((c) => c.argv.includes("remember"));
				assert.ok(rememberCalls.length >= 1);
				for (const c of rememberCalls) assert.equal(c.argv[c.argv.indexOf("--db") + 1], db.dbPath, "write pinned to the probed path");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});
});
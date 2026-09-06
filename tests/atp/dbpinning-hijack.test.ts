/**
 * B2-3 — EDEN_DB_PATH hijack defense (the 2026-09-06 incident): a project-level
 * .env makes the CLI resolve EDEN_DB_PATH before the default DB. The extension
 * must probe that path via health and pin --db so reads AND writes land in the
 * same (here: hijacked) file — never split-brain.
 * Runs in its own test-file process: the probe result is cached per module.
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

describe("B2-3: project .env EDEN_DB_PATH hijack defense", () => {
	it("probe follows the hijacked path; reads and writes land in the same file", async () => {
		// The "hijacked" DB — seeded so the board read can prove it reads this file.
		const hijacked = createFixtureDb([fixtureRecord({ body: "record only in the hijacked db" })]);
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv(
				testEnv({
					EDEN_MEMORY_BIN: binPath,
					EDEN_FIXTURE_LOG: logPath,
					// stub's health reports the effective db_path (what the real CLI
					// resolves from a project-level .env EDEN_DB_PATH)
					EDEN_FIXTURE_DB_PATH: hijacked.dbPath,
					// simulate the hijack itself: env var present in the process
					EDEN_DB_PATH: hijacked.dbPath,
				}),
				async () => {
					const { tools } = await loadExtension();
					const { ctx } = createMockCtx();

					const status = await tools.get("team_status")!.execute("b23a", {}, undefined, () => {}, ctx);
					assert.equal(status.details.count, 1, "board read the HIJACKED db (probed path), not the default");
					assert.equal(status.details.goals[0].latestBody.includes("hijacked db"), true);

					const remember = await tools.get("team_remember")!.execute(
						"b23b",
						{ agent_id: "builder", goal_id: TEST_GOAL, stage: "action", owner_role: "builder", body: "write into the same file" },
						undefined,
						() => {},
						ctx,
					);
					assert.ok(remember.details.recordId, "write succeeded");

					const calls = await readArgvLog(logPath);
					// write side: --db pinned to the probed (hijacked) path; read side proven
					// by the board read above surfacing the hijacked-DB record
					const rememberCalls = calls.filter((c) => c.argv.includes("remember"));
					assert.ok(rememberCalls.length >= 1);
					for (const c of rememberCalls) assert.equal(c.argv[c.argv.indexOf("--db") + 1], hijacked.dbPath);
				},
			);
		} finally {
			dispose();
			hijacked.dispose();
		}
	});
});
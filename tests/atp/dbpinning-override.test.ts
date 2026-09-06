/**
 * B2-1 + B2-4 — explicit EDEN_MEMORY_DB override skips the probe entirely;
 * dbHint only fires when the effective DB is not the default path.
 * Own file: dbpinning-probe/hijack tests rely on a fresh probe cache.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	TEST_GOAL,
	createMockCtx,
	importExtension,
	installFixtureBin,
	loadExtension,
	readArgvLog,
	testEnv,
	withEnv,
} from "./harness.ts";

const mod = await importExtension();

describe("B2-1: EDEN_MEMORY_DB override skips the health probe", () => {
	it("no health call observed; --db pinned to the env override", async () => {
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			const dbPath = "/tmp/atp-override.db";
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: dbPath, EDEN_FIXTURE_LOG: logPath }), async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				const remember = await tools.get("team_remember")!.execute(
					"b21",
					{ agent_id: "builder", goal_id: TEST_GOAL, stage: "action", owner_role: "builder", body: "x" },
					undefined,
					() => {},
					ctx,
				);
				assert.ok(remember.details.recordId, "write succeeded");
				const calls = await readArgvLog(logPath);
				assert.equal(calls.filter((c) => c.argv.includes("health")).length, 0, "probe skipped when EDEN_MEMORY_DB is set");
				const rememberCall = calls.find((c) => c.argv.includes("remember"))!;
				assert.equal(rememberCall.argv[rememberCall.argv.indexOf("--db") + 1], dbPath, "--db = env override");
			});
		} finally {
			dispose();
		}
	});
});

describe("B2-4: dbHint — silent for the default path, hint otherwise", () => {
	it("empty hint when the DB is the default location", async () => {
		await withEnv(testEnv({ EDEN_MEMORY_DB: join(homedir(), ".eden-memory", "default.db") }), async () => {
			const { ctx } = createMockCtx();
			const cfg = mod.edenConfig(ctx);
			assert.equal(mod.dbHint(cfg), "");
		});
	});

	it("hint emitted (and containing the path) for any non-default DB", async () => {
		await withEnv(testEnv({ EDEN_MEMORY_DB: "/tmp/atp-nondefault.db" }), async () => {
			const { ctx } = createMockCtx();
			const cfg = mod.edenConfig(ctx);
			const hint = mod.dbHint(cfg);
			assert.ok(hint.includes("· db"), "hint marker present");
			assert.ok(hint.includes("/tmp/atp-nondefault.db"), "hint names the non-default path");
		});
	});
});
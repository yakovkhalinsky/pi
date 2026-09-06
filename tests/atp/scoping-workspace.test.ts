/**
 * B3 — workspace scoping (F2): resolution order, workspace stated in outputs,
 * workspace pinned on CLI writes, no silent cross-workspace reads.
 * Tool-level (T2) against a fixture DB + stub CLI.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	installFixtureBin,
	loadExtension,
	readArgvLog,
	withEnv,
} from "./harness.ts";

const mod = await importExtension();

const identityOnly = { EDEN_ORG_ID: TEST_ORG, USER_ID: TEST_USER };

describe("B3-1: workspace resolution order", () => {
	it("explicit param > env ATP_WORKSPACE_ID > env WORKSPACE_ID", async () => {
		await withEnv({ ...identityOnly, ATP_WORKSPACE_ID: "env-atp-ws", WORKSPACE_ID: "env-ws" }, async () => {
			const { ctx } = createMockCtx();
			assert.deepEqual(
				((cfg) => [cfg.workspaceId, cfg.workspaceSource])(mod.edenConfig(ctx, "param-ws")),
				["param-ws", "explicit param"],
			);
			assert.deepEqual(
				((cfg) => [cfg.workspaceId, cfg.workspaceSource])(mod.edenConfig(ctx)),
				["env-atp-ws", "env ATP_WORKSPACE_ID"],
				"ATP_WORKSPACE_ID wins over WORKSPACE_ID",
			);
		});
		await withEnv({ ...identityOnly, ATP_WORKSPACE_ID: undefined, WORKSPACE_ID: "env-ws" }, async () => {
			const { ctx } = createMockCtx();
			assert.deepEqual(
				((cfg) => [cfg.workspaceId, cfg.workspaceSource])(mod.edenConfig(ctx)),
				["env-ws", "env WORKSPACE_ID"],
			);
		});
	});

	it("session cache (git toplevel) used when no env override", async () => {
		const gitExec = (cmd: string, args: string[]) =>
			args[0] === "rev-parse" ? Promise.resolve({ code: 0, stdout: "/tmp/myrepo\n", stderr: "" }) : execRun(cmd, args);
		const { pi } = await loadExtension({ exec: gitExec });
		await withEnv({ ...identityOnly, ATP_WORKSPACE_ID: undefined, WORKSPACE_ID: undefined }, async () => {
			const { ctx } = createMockCtx();
			await pi.__emit("session_start", {}, ctx);
			const cfg = mod.edenConfig(ctx);
			assert.deepEqual([cfg.workspaceId, cfg.workspaceSource], ["myrepo", "session (git toplevel)"]);
			await pi.__emit("session_shutdown"); // clear cachedWorkspace for other tests
		});
	});

	it("cwd basename when cache empty and no env override (no session_start fired)", async () => {
		const { pi } = await loadExtension();
		await withEnv({ ...identityOnly, ATP_WORKSPACE_ID: undefined, WORKSPACE_ID: undefined }, async () => {
			const { ctx } = createMockCtx({ cwd: join(tmpdir(), "somerepo") });
			// no session_start: cachedWorkspace stays empty → edenConfig falls to cwd
			const cfg = mod.edenConfig(ctx);
			assert.deepEqual([cfg.workspaceId, cfg.workspaceSource], ["somerepo", "cwd"]);
			await pi.__emit("session_shutdown");
		});
	});
});

describe("B3-2: team_status states and scopes the queried workspace", () => {
	it("explicit workspace param is stated and scoped (no silent reads elsewhere)", async () => {
		const db = createFixtureDb([fixtureRecord({ body: "ws record" })]); // lives in TEST_WS
		const { binPath, dispose } = installFixtureBin();
		try {
			await withEnv({ EDEN_ORG_ID: TEST_ORG, USER_ID: TEST_USER, EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath }, async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				const result = await tools.get("team_status")!.execute("b32", { workspace: "other-ws" }, undefined, () => {}, ctx);
				assert.equal(result.details.workspace, "other-ws");
				assert.equal(result.details.workspaceSource, "explicit param");
				assert.equal(result.details.count, 0, "records of another workspace are not read silently");
				assert.ok(result.content[0].text.includes("workspace other-ws (explicit param)"), "workspace stated in text");
				assert.ok(result.content[0].text.includes("No active goals"), "empty-but-loud, not cross-workspace leakage");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});
});

describe("B3-3: team_remember pins the resolved --workspace-id", () => {
	it("explicit workspace param wins end-to-end (argv)", async () => {
		const db = createFixtureDb([]);
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv({ EDEN_ORG_ID: TEST_ORG, USER_ID: TEST_USER, EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath, ATP_WORKSPACE_ID: TEST_WS }, async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				await tools.get("team_remember")!.execute(
					"b33",
					{ agent_id: "builder", goal_id: TEST_GOAL, stage: "action", owner_role: "builder", body: "x", workspace: "param-ws" },
					undefined,
					() => {},
					ctx,
				);
				const calls = await readArgvLog(logPath);
				const rememberCall = calls.find((c) => c.argv.includes("remember"))!;
				assert.equal(rememberCall.argv[rememberCall.argv.indexOf("--workspace-id") + 1], "param-ws", "explicit param beats env");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});
});

describe("B3-4: team_recall states the queried workspace; agent_id required", () => {
	it("recall output and argv carry workspace + agent scoping", async () => {
		const db = createFixtureDb([]);
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv(
				{
					EDEN_ORG_ID: TEST_ORG,
					USER_ID: TEST_USER,
					EDEN_MEMORY_BIN: binPath,
					EDEN_MEMORY_DB: db.dbPath,
					EDEN_FIXTURE_LOG: logPath,
					ATP_WORKSPACE_ID: TEST_WS,
					EDEN_FIXTURE_RECALL_JSON: JSON.stringify([
						{ id: "aaaa-bbbb", score: 0.82, content: `Goal: ${TEST_GOAL} | Stage: action | Owner: builder\ndid the thing` },
						{ id: "cccc-dddd", content: "no score here" },
					]),
				},
				async () => {
					const { tools } = await loadExtension();
					const { ctx } = createMockCtx();
					const result = await tools.get("team_recall")!.execute(
						"b34",
						{ agent_id: "builder", query: "the thing" },
						undefined,
						() => {},
						ctx,
					);
					const text = result.content[0].text;
					assert.ok(text.includes(`workspace ${TEST_WS} (env ATP_WORKSPACE_ID)`), "workspace stated");
					assert.equal(result.details.workspace, TEST_WS);
					assert.equal(result.details.results.length, 2);
					assert.ok(text.includes("[0.82]"), "score rendered");
					assert.ok(text.includes("[—]"), "missing score renders as em dash");

					const calls = await readArgvLog(logPath);
					const recallCall = calls.find((c) => c.argv.includes("recall"))!;
					const argv = recallCall.argv;
					assert.ok(argv.includes("--agent-id"), "agent_id flag required by the CLI");
					assert.equal(argv[argv.indexOf("--workspace-id") + 1], TEST_WS);
					assert.equal(argv[argv.indexOf("--query") + 1], "the thing");
					assert.equal(argv[argv.indexOf("--limit") + 1], "10", "default limit applied");
				},
			);
		} finally {
			dispose();
			db.dispose();
		}
	});
});

describe("B3-5: cross-workspace isolation (T2 proof of the aggregate scoping)", () => {
	it("records of workspace A are invisible from workspace B and vice versa", async () => {
		const goalA = "99999999-9999-4999-8999-999999999999";
		const goalB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const db = createFixtureDb([
			fixtureRecord({ goalId: goalA, workspaceId: "ws-a", body: "goal in ws-a", createdAt: 1_760_000_001 }),
			fixtureRecord({ goalId: goalB, workspaceId: "ws-b", body: "goal in ws-b", createdAt: 1_760_000_002 }),
		]);
		try {
			const { binPath, dispose } = installFixtureBin();
			try {
				await withEnv({ EDEN_ORG_ID: TEST_ORG, USER_ID: TEST_USER, EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, ATP_WORKSPACE_ID: TEST_WS }, async () => {
					const { tools } = await loadExtension();
					const { ctx } = createMockCtx();
					const fromDefault = await tools.get("team_status")!.execute("b35a", {}, undefined, () => {}, ctx);
					assert.equal(fromDefault.details.count, 0, "no records in TEST_WS → empty, not leaked");
					const fromA = await tools.get("team_status")!.execute("b35b", { workspace: "ws-a" }, undefined, () => {}, ctx);
					assert.deepEqual(fromA.details.goals.map((g: any) => g.goalId), [goalA]);
					const fromB = await tools.get("team_status")!.execute("b35c", { workspace: "ws-b" }, undefined, () => {}, ctx);
					assert.deepEqual(fromB.details.goals.map((g: any) => g.goalId), [goalB]);
				});
			} finally {
				dispose();
			}
		} finally {
			db.dispose();
		}
	});
});
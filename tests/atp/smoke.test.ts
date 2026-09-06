/**
 * M1 smoke test — proves every seam in tests/atp/harness.ts works against the
 * real extension module (tests/TEST-SCOPE.md §6, milestone M1 exit criteria):
 *   1. mock-pi loading: tools + commands registered
 *   2. pure-function seam: classifyState mirrors the SKILL router table
 *   3. sqlite pass-through: team_status reads a fixture DB end-to-end
 *   4. fixture CLI: team_remember stores via the stub, captures the id, pins --db
 *   5. rendering seam: renderResult produces renderable TUI lines
 *   6. missing-org loud failure (no silent empties)
 *   7. theme mock: ANSI tagging transparent to content
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
	TEST_GOAL,
	TEST_ORG,
	TEST_USER,
	TEST_WS,
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

describe("M1 smoke: harness seams", () => {
	let db: { dbPath: string; dispose: () => void };

	before(async () => {
		db = createFixtureDb([
			fixtureRecord({ recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", body: "ship the thing", createdAt: 1_760_000_001 }),
			fixtureRecord({ recordType: "action_record", stage: "action", owner: "builder", status: "completed", body: "did the thing", createdAt: 1_760_000_002 }),
			fixtureRecord({
				recordType: "pending_authorisation",
				stage: "pending_authorisation",
				owner: "runtime",
				status: "pending_authorisation",
				body: "force-push protection removal — approve?",
				createdAt: 1_760_000_003,
			}),
		]);
	});

	after(() => db.dispose());

	it("registers the six team tools and two commands", async () => {
		const { tools, commands } = await loadExtension();
		for (const name of ["team_status", "team_recall", "team_remember", "team_lookup", "team_decide", "team_steer"]) {
			assert.ok(tools.has(name), `tool ${name} registered`);
		}
		assert.deepEqual([...commands.keys()].sort(), ["steer", "team-board"]);
	});

	it("classifyState mirrors the SKILL.md router lifecycle table", async () => {
		const mod = await importExtension();
		const rec = (over: { recordType?: string; status?: string; stage?: string; owner?: string }) =>
			mod.parseRecord(
				fixtureRecord({
					recordType: over.recordType ?? "",
					status: over.status ?? "",
					stage: over.stage ?? "action",
					owner: over.owner ?? "builder",
					createdAt: 1_760_000_009,
				}),
			)!;
		assert.equal(mod.classifyState(rec({ recordType: "verdict", status: "green" })), "active");
		assert.equal(mod.classifyState(rec({ recordType: "verdict", status: "red" })), "continueable");
		assert.equal(mod.classifyState(rec({ recordType: "verdict", status: "blocked" })), "blocked");
		assert.equal(mod.classifyState(rec({ recordType: "archival_record", status: "completed" })), "closed");
		assert.equal(mod.classifyState(rec({ recordType: "authorisation_record", status: "approved" })), "continueable");
		assert.equal(mod.classifyState(rec({ recordType: "authorisation_record", status: "deferred" })), "pending_authorisation");
		assert.equal(mod.classifyState(rec({ recordType: "hand_off_record", owner: "archivist" }), false), "continueable");
		assert.equal(mod.classifyState(rec({ recordType: "hand_off_record", owner: "archivist", stage: "hand_off_or_closure" }), true), "closed");
		assert.equal(mod.classifyState(rec({ recordType: "hand_off_record", owner: "router", stage: "routing_and_assignment" }), true), "continueable");
		// F5a: a parked action recorded as pending_authorisation never reads active
		assert.equal(
			mod.classifyState(rec({ recordType: "pending_authorisation", status: "pending_authorisation", stage: "action" })),
			"pending_authorisation",
		);
	});

	it("team_status reads the fixture DB through the real sqlite3 CLI", async () => {
		await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath }), async () => {
			const { tools } = await loadExtension();
			const { ctx } = createMockCtx();
			const result = await tools.get("team_status")!.execute("t1", {}, undefined, () => {}, ctx);
			const details = result.details;
			assert.equal(details.count, 1, "one goal summarized");
			assert.equal(details.workspace, TEST_WS);
			assert.equal(details.workspaceSource, "env ATP_WORKSPACE_ID");
			assert.equal(details.goals[0].state, "pending_authorisation");
			// latest record wins: the runtime pending item is the goal's current state
			assert.equal(details.goals[0].owner, "runtime");
			const text = result.content[0].text;
			assert.ok(text.includes("NEEDS HUMAN DECISION"), "pending item surfaced in text");
			assert.ok(text.includes("workspace test-ws (env ATP_WORKSPACE_ID)"), "workspace stated");
		});
	});

	it("team_remember stores via the fixture CLI, captures the assigned id, pins --db", async () => {
		const { binPath, logPath, dispose } = installFixtureBin();
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath }), async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				const result = await tools.get("team_remember")!.execute(
					"t2",
					{
						agent_id: "builder",
						goal_id: TEST_GOAL,
						stage: "action",
						owner_role: "builder",
						record_type: "action_record",
						status: "completed",
						body: "wrote the harness",
					},
					undefined,
					() => {},
					ctx,
				);
				const details = result.details;
				assert.ok(details.recordId, "record id captured");
				assert.match(details.recordId, /^[0-9a-f-]{36}$/);
				assert.equal(details.error, undefined);
				assert.equal(details.workspace, TEST_WS);

				// argv contract: --db pinned, org/workspace/user scoping present
				// (the log's argv starts after the binary path, so match on the subcommand)
				const calls = await readArgvLog(logPath);
				const rememberCall = calls.find((c) => c.argv.includes("remember"));
				assert.ok(rememberCall, "fixture CLI saw a remember call");
				const argv = rememberCall.argv;
				const flag = (name: string) => {
					const i = argv.indexOf(name);
					return i === -1 ? undefined : argv[i + 1];
				};
				assert.equal(flag("--db"), db.dbPath, "--db pinned to EDEN_MEMORY_DB");
				assert.equal(flag("--org-id"), TEST_ORG);
				assert.equal(flag("--workspace-id"), TEST_WS);
				assert.equal(flag("--user-id"), TEST_USER);
				assert.equal(flag("--agent-id"), "builder");
				assert.ok(flag("--content")!.startsWith(`Goal: ${TEST_GOAL} | Stage: action | Owner: builder`), "identity line present");
			});

			// rendering seam: the confirmation card renders to TUI lines
			const { tools } = await loadExtension();
			const { ctx, theme } = createMockCtx();
			const result = await tools.get("team_remember")!.execute(
				"t3",
				{ agent_id: "builder", goal_id: TEST_GOAL, stage: "action", owner_role: "builder", body: "second write" },
				undefined,
				() => {},
				ctx,
			);
			const component = tools.get("team_remember")!.renderResult(result, { expanded: false }, theme, ctx);
			const lines = component.render(100).map(stripAnsi);
			assert.ok(lines.join("\n").includes("✓ stored"), "confirmation card renders");
		} finally {
			dispose();
		}
	});

	it("missing org id fails loudly instead of returning silent empties", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "atp-no-org-"));
		await withEnv(
			{
				EDEN_ORG_ID: undefined, // env cleared; fake HOME has no ~/.eden-memory/.env
				USER_ID: TEST_USER,
				ATP_WORKSPACE_ID: TEST_WS,
				EDEN_MEMORY_DB: db.dbPath,
				HOME: fakeHome,
			},
			async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				const result = await tools.get("team_status")!.execute("t4", {}, undefined, () => {}, ctx);
				assert.ok(result.details.dbError, "dbError carries the missing-org message");
				assert.ok(result.content[0].text.includes("EDEN_ORG_ID"), "loud fix named in text");
			},
		);
	});

	it("theme mock tags colors without breaking width math", async () => {
		const mod = await importExtension();
		const ansiTheme = createTheme("ansi");
		const plainTheme = createTheme("passthrough");
		const rec = mod.parseRecord(fixtureRecord({}) as any)!;
		const summary = mod.summarizeGoals([rec])[0]!;
		const ansiRow = mod.boardRow(ansiTheme, summary, false);
		const plainRow = mod.boardRow(plainTheme, summary, false);
		assert.equal(stripAnsi(ansiRow), plainRow, "ansi wrapper is transparent to content");
	});
});
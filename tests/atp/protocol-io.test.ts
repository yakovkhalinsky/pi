/**
 * Scope A6 + B4 — team_remember identity-line contract and empty-id handling.
 * Runs against the stub CLI binary (T2 tier).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	TEST_GOAL,
	TEST_USER,
	TEST_WS,
	fixtureRecord,
	importExtension,
	installFixtureBin,
	loadExtension,
	createMockCtx,
	createFixtureDb,
	readArgvLog,
	testEnv,
	withEnv,
} from "./harness.ts";

describe("A6: team_remember identity-line alignment", () => {
	it("A6-1/A6-2: identity line is exactly Goal|Stage|Owner — no pre-generated Record ID placeholder survives", async () => {
		const { binPath, logPath, dispose } = installFixtureBin();
		const db = createFixtureDb([fixtureRecord({})]);
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath }), async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				const result = await tools.get("team_remember")!.execute(
					"a6",
					{ agent_id: "builder", goal_id: TEST_GOAL, stage: "action", owner_role: "builder", record_type: "action_record", status: "completed", body: "body with uuidgen-claimed id: Record ID: pending" },
					undefined,
					() => {},
					ctx,
				);
				assert.ok(result.details.recordId, "stored id is the CLI-assigned one");
				const calls = await readArgvLog(logPath);
				const rememberCall = calls.find((c) => c.argv.includes("remember"))!;
				const content = rememberCall.argv[rememberCall.argv.indexOf("--content") + 1];
				assert.ok(content.startsWith(`Goal: ${TEST_GOAL} | Stage: action | Owner: builder\n`), "identity line format");
				assert.ok(content.endsWith("body with uuidgen-claimed id: Record ID: pending"), "body passed through verbatim");
				// The identity line itself carries no fabricated Record ID (F6c: the
				// stored id is canonical and comes back from the CLI, not uuidgen).
				const identityLine = content.split("\n")[0];
				assert.ok(!identityLine.includes("Record ID:"), "no placeholder Record ID in identity line");
				// protocol marker always present in metadata
				const mdRaw = rememberCall.argv[rememberCall.argv.indexOf("--metadata") + 1];
				const md = JSON.parse(mdRaw);
				assert.equal(md.protocol, "agentic-team-protocol");
				assert.equal(md.goal_id, TEST_GOAL);
				assert.equal(md.record_type, "action_record");
				assert.equal(md.status, "completed");
				assert.equal(md.owner_role, "builder");
				assert.equal(md.stage, "action");
				assert.equal(md.user_id ?? undefined, undefined, "user id is not duplicated into metadata");
				void TEST_USER;
				void TEST_WS;
			});
		} finally {
			dispose();
			db.dispose();
		}
	});
});

describe("B4: empty-id / transient-failure handling in team_remember", () => {
	it("B4-1: CLI success without an id is surfaced loudly, never as success", async () => {
		const { binPath, dispose } = installFixtureBin();
		const db = createFixtureDb([]);
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_MODE: "empty-id" }), async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				const result = await tools.get("team_remember")!.execute(
					"b41",
					{ agent_id: "builder", goal_id: TEST_GOAL, stage: "action", owner_role: "builder", body: "x" },
					undefined,
					() => {},
					ctx,
				);
				assert.equal(result.details.recordId, "");
				assert.equal(result.details.error, "eden-memory returned success but no record id");
				assert.ok(result.content[0].text.startsWith("Failed to store team record"), "text says failed");
				assert.ok(!result.content[0].text.includes("Stored team record"), "no success wording");
			});
		} finally {
			dispose();
			db.dispose();
		}
	});

	it("B4-2: transient failure (empty id) still fails loudly — CLI-level retry is eden.sh's contract, the tool's is no silent empties", async () => {
		const { binPath, statePath, dispose } = installFixtureBin();
		const db = createFixtureDb([]);
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_MODE: "fail-twice-then-ok", EDEN_FIXTURE_STATE: statePath }), async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				const result = await tools.get("team_remember")!.execute(
					"b42",
					{ agent_id: "builder", goal_id: TEST_GOAL, stage: "action", owner_role: "builder", body: "x" },
					undefined,
					() => {},
					ctx,
				);
				// the extension tool makes a single call: a transient attempt yields the
				// audited loud failure (retry-until-id is eden.sh's eden_remember
				// contract, tested at bash tier in B1-2)
				assert.equal(result.details.recordId, "");
				assert.equal(result.details.error, "eden-memory returned success but no record id");
				assert.ok(result.content[0].text.startsWith("Failed to store team record"));
			});
		} finally {
			dispose();
			db.dispose();
		}
	});
});

describe("A7: team_decide authorisation semantics", () => {
	async function decideWith(env: Record<string, string | undefined>, goalRecords: any[], params: any) {
		const { binPath, logPath, dispose } = installFixtureBin();
		const db = createFixtureDb(goalRecords);
		try {
			return await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath, ...env }), async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				const result = await tools.get("team_decide")!.execute("a7", params, undefined, () => {}, ctx);
					const calls = await readArgvLog(logPath);
				// team_decide makes exactly one CLI write: the authorisation_record
				const rememberCall = calls.find((c) => c.argv.includes("remember"));
				const md = rememberCall ? JSON.parse(rememberCall.argv[rememberCall.argv.indexOf("--metadata") + 1]) : null;
				return { result, md, content: rememberCall ? rememberCall.argv[rememberCall.argv.indexOf("--content") + 1] : "", db, dispose };
			});
		} finally {
			dispose();
			db.dispose();
		}
	}

	const pendingGoal = [
		fixtureRecord({ recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", createdAt: 1_760_000_001 }),
		fixtureRecord({
			recordType: "pending_authorisation",
			stage: "pending_authorisation",
			owner: "runtime",
			status: "pending_authorisation",
			body: "prepared: rotate creds",
			createdAt: 1_760_000_002,
		}),
	];

	it("A7-1 approve: authorisation_record references the pending record in input_record_ids", async () => {
		const { result, md } = await decideWith({}, pendingGoal, { goal_id: TEST_GOAL, decision: "approve" });
		assert.ok(md, "authorisation record written via CLI");
		assert.equal(md.record_type, "authorisation_record");
		assert.equal(md.status, "approved");
		assert.equal(md.decision, "approve");
		assert.deepEqual(md.input_record_ids, [pendingGoal[1].id], "references the actual pending record");
		assert.ok(result.details.priorRecordId === pendingGoal[1].id);
		assert.ok(result.content[0].text.includes("Spawn the router subagent"), "approve → router continues");
	});

	it("A7-2: decision note persisted in the record content", async () => {
		const { content } = await decideWith({}, pendingGoal, { goal_id: TEST_GOAL, decision: "approve", note: "user said yes on standup" });
		assert.ok(content.includes("approved — user said yes on standup"));
	});

	it("A7-3: works against a CLOSED goal — references the stranded pending record, router owns continuation", async () => {
		const closedGoal = [
			...pendingGoal,
			fixtureRecord({ recordType: "archival_record", owner: "archivist", status: "completed", createdAt: 1_760_000_003 }),
		];
		const { result, md, content } = await decideWith({}, closedGoal, { goal_id: TEST_GOAL, decision: "approve" });
		assert.equal(result.details.goalClosed, true);
		assert.equal(md.input_record_ids[0], pendingGoal[1].id, "pending record, not the closure record");
		assert.ok(content.includes("Goal state: closed"), "post-closure decision noted in content");
		assert.ok(result.content[0].text.includes("Goal state is closed"), "router-continuation messaging");
	});

	it("A7-4 defer: goal stays pending — no auto-continuation wording", async () => {
		const { result, md } = await decideWith({}, pendingGoal, { goal_id: TEST_GOAL, decision: "defer" });
		assert.equal(md.status, "deferred");
		assert.ok(result.content[0].text.includes("stays pending_authorisation"));
		assert.ok(!result.content[0].text.includes("Spawn the router"), "defer does not spawn continuation");
	});

	it("A7-5 reject: router rework/closure wording", async () => {
		const { result, md } = await decideWith({}, pendingGoal, { goal_id: TEST_GOAL, decision: "reject" });
		assert.equal(md.status, "rejected");
		assert.ok(result.content[0].text.includes("rework or closure"));
	});
});
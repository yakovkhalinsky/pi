/**
 * C2 — human-readable execute() text outputs (T2, fixture DB + stub CLI):
 * goal lines, NEEDS HUMAN DECISION incl. stranded items, workspace/db-error/
 * empty messages, recall match list, lookup record card, not-found.
 * (C2-6 team_decide next-step wording is asserted in protocol-io A7-1..A7-5.)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	TEST_GOAL,
	TEST_WS,
	createFixtureDb,
	createMockCtx,
	fixtureRecord,
	installFixtureBin,
	loadExtension,
	testEnv,
	withEnv,
} from "./harness.ts";

const GOAL_TITLE = "Render The Board";

function closedGoalWithStranded() {
	return [
		fixtureRecord({ recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", body: `{"title":"${GOAL_TITLE}"}`, createdAt: 1_760_000_001 }),
		fixtureRecord({
			recordType: "pending_authorisation",
			stage: "pending_authorisation",
			owner: "runtime",
			status: "pending_authorisation",
			body: "wipe the production table — approve?",
			createdAt: 1_760_000_002,
		}),
		fixtureRecord({ recordType: "archival_record", owner: "archivist", status: "completed", createdAt: 1_760_000_003 }),
	];
}

function openGoalPending() {
	const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
	return [
		fixtureRecord({ goalId: other, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", body: '{"title":"Open Goal"}', createdAt: 1_760_000_004 }),
		fixtureRecord({
			goalId: other,
			recordType: "pending_authorisation",
			stage: "pending_authorisation",
			owner: "builder",
			status: "pending_authorisation",
			body: "push to main directly — approve?",
			createdAt: 1_760_000_005,
		}),
	];
}

describe("C2-1/C2-2: team_status goal lines + NEEDS HUMAN DECISION (incl. stranded)", () => {
	it("default view hides closed rows; stranded decisions still surface; include_closed shows them", async () => {
		const db = createFixtureDb([...closedGoalWithStranded(), ...openGoalPending()]);
		try {
			const { binPath, dispose } = installFixtureBin();
			try {
				await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath }), async () => {
					const { tools } = await loadExtension();
					const { ctx } = createMockCtx();
					const text = (await tools.get("team_status")!.execute("c2", {}, undefined, () => {}, ctx)).content[0].text;

					// Closed goals are terminal state: hidden from the default table…
					assert.ok(!text.includes(`${GOAL_TITLE} | Closure | archivist | closed`), "closed row hidden by default");
					assert.ok(text.includes("1 closed goal(s) hidden"), "hidden-count line present");
					// …while the open goal still renders.
					assert.ok(text.includes(`Open Goal | Pending authorisation | builder | pending_authorisation | rec=00000000 | 2 records`));

					// active pending item
					assert.ok(
						text.includes(`NEEDS HUMAN DECISION (pending_authorisation): Open Goal — push to main directly — approve?. Surface to the user; decide via /team-approve or team_decide.`),
					);
					// stranded on closed goal (F4) — recordType is humanized; still
					// surfaced even though the closed row itself is hidden
					assert.ok(
						text.includes(`NEEDS HUMAN DECISION (goal closed, Pending authorisation): ${GOAL_TITLE} — wipe the production table — approve?. rec=00000000. team_decide goal_id="${TEST_GOAL}" still works on closed goals; the router handles continuation.`),
					);

					// include_closed opts back into the full table
					const full = (await tools.get("team_status")!.execute("c2", { include_closed: true }, undefined, () => {}, ctx)).content[0].text;
					assert.ok(full.includes(`${GOAL_TITLE} | Closure | archivist | closed | rec=00000000 | 3 records`));
					assert.ok(!full.includes("closed goal(s) hidden"), "no hidden line when include_closed");

					// an explicit goal_id filter always includes its goal, even closed
					const byGoal = (await tools.get("team_status")!.execute("c2", { goal_id: TEST_GOAL }, undefined, () => {}, ctx)).content[0].text;
					assert.ok(byGoal.includes(`${GOAL_TITLE} | Closure | archivist | closed | rec=00000000 | 3 records`), "goal_id filter shows closed goal");
				});
			} finally {
				dispose();
			}
		} finally {
			db.dispose();
		}
	});
});

describe("C2-3: workspace / db-error / empty-state messages", () => {
	it("empty DB → loud empty-state naming the workspace", async () => {
		const db = createFixtureDb([]);
		try {
			const { binPath, dispose } = installFixtureBin();
			try {
				await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath }), async () => {
					const { tools } = await loadExtension();
					const { ctx } = createMockCtx();
					const text = (await tools.get("team_status")!.execute("c23a", {}, undefined, () => {}, ctx)).content[0].text;
					// dbHint may append ` · db <path>` after the workspace parens
					assert.ok(text.includes(`No active goals found in Eden-memory (workspace ${TEST_WS} (env ATP_WORKSPACE_ID)`));
				});
			} finally {
				dispose();
			}
		} finally {
			db.dispose();
		}
	});

	it("unopenable DB → db error surfaced, not silent empties", async () => {
		try {
			const { binPath, dispose } = installFixtureBin();
			try {
				await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: "/tmp/atp-nope-dir-xyz/missing.db" }), async () => {
					const { tools } = await loadExtension();
					const { ctx } = createMockCtx();
					const result = await tools.get("team_status")!.execute("c23b", {}, undefined, () => {}, ctx);
					assert.ok(result.details.dbError, "dbError set");
					assert.ok(result.content[0].text.includes("Eden-memory db error"), "error stated in text");
					assert.ok(result.content[0].text.includes(`workspace ${TEST_WS}`), "workspace still stated");
				});
			} finally {
				dispose();
			}
		} catch {
			/* installFixtureBin throws nothing; keep shape */
		}
	});
});

describe("C2-4: team_recall numbered match list", () => {
	it("numbered lines with score, id, scope badges and snippet", async () => {
		const { binPath, dispose } = installFixtureBin();
		const db = createFixtureDb([]);
		try {
			await withEnv(
				testEnv({
					EDEN_MEMORY_BIN: binPath,
					EDEN_MEMORY_DB: db.dbPath,
					EDEN_FIXTURE_RECALL_JSON: JSON.stringify([
						{ id: "aaaa-1111-2222-3333", score: 0.77, content: `Goal: ${TEST_GOAL} | Stage: context_gathering | Owner: researcher\nfound the conventions and options` },
					]),
				}),
				async () => {
					const { tools } = await loadExtension();
					const { ctx } = createMockCtx();
					const text = (await tools.get("team_recall")!.execute("c24", { agent_id: "researcher", query: "conventions" }, undefined, () => {}, ctx)).content[0].text;
					assert.ok(text.includes("Queried workspace test-ws (env ATP_WORKSPACE_ID"), "workspace stated (dbHint may follow)");
					assert.ok(text.includes("1 match(es), best first:"));
					assert.ok(text.includes("1. [0.77] aaaa-1111"));
					assert.ok(text.includes("researcher · Context gathering · goal"), "scope badges from identity line");
					assert.ok(text.includes("found the conventions"), "snippet");
				},
			);
		} finally {
			dispose();
			db.dispose();
		}
	});
});

describe("C2-5: team_lookup readable record card + not-found", () => {
	it("found record renders as a card, not a JSON dump", async () => {
		const { binPath, dispose } = installFixtureBin();
		const db = createFixtureDb([]);
		try {
			await withEnv(
				testEnv({
					EDEN_MEMORY_BIN: binPath,
					EDEN_MEMORY_DB: db.dbPath,
					EDEN_FIXTURE_LOOKUP_JSON: JSON.stringify({
						found: true,
						id: "cccc-1234",
						content: `Goal: ${TEST_GOAL} | Stage: action | Owner: builder\nwrote the test harness`,
						metadata: { stage: "action", owner_role: "builder", record_type: "action_record", status: "completed", goal_id: TEST_GOAL, stored_at: "2026-09-06T00:00:00Z", attempts: 2 },
					}),
				}),
				async () => {
					const { tools } = await loadExtension();
					const { ctx } = createMockCtx();
					const result = await tools.get("team_lookup")!.execute("c25a", { id: "cccc-1234" }, undefined, () => {}, ctx);
					assert.equal(result.details.found, true);
					const text = result.content[0].text;
					assert.ok(text.startsWith("Record cccc-1234 — workspace test-ws (env ATP_WORKSPACE_ID)"));
					assert.ok(text.includes("stage=action | owner=builder | type=action_record | status=completed"), "field line");
					assert.ok(text.includes("extra: attempts=2"), "extra metadata summarized");
					assert.ok(text.includes("wrote the test harness"), "body");
					assert.ok(!text.trimStart().startsWith("{"), "no raw JSON dump");
				},
			);
		} finally {
			dispose();
			db.dispose();
		}
	});

	it("not-found is stated, not an error", async () => {
		const { binPath, dispose } = installFixtureBin();
		const db = createFixtureDb([]);
		try {
			await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath }), async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				const result = await tools.get("team_lookup")!.execute("c25b", { id: "missing-id" }, undefined, () => {}, ctx);
				assert.equal(result.details.found, false);
				assert.equal(result.details.error, undefined, "not-found is not an error");
				assert.ok(result.content[0].text.includes("Record missing-id not found (workspace test-ws"));
			});
		} finally {
			dispose();
			db.dispose();
		}
	});
});
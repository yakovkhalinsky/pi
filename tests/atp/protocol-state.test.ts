/**
 * Scope A — protocol adherence, pure-function tier (T1).
 * A1 lifecycle state machine, A2 goal summarization, A3 stranded pending (F4),
 * A4 record schema & identity lines, A5 record-type discipline (F5a).
 * No env needed — everything runs on parseRecord(fixtureRecord(...)) inputs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FIXTURE_BASE_TS, TEST_GOAL, fixtureRecord, importExtension } from "./harness.ts";

// ESM top-level await: load the extension module once per test-file process.
const mod = await importExtension();

describe("A1: classifyState mirrors the SKILL.md router lifecycle table", () => {
	const rec = (over: { recordType?: string; status?: string; stage?: string; owner?: string }) =>
		mod.parseRecord(
			fixtureRecord({
				recordType: over.recordType ?? "",
				status: over.status ?? "",
				stage: over.stage ?? "action",
				owner: over.owner ?? "builder",
				createdAt: FIXTURE_BASE_TS + 9,
			}),
		)!;

	it("A1-1: status containing 'blocked' wins over type/stage", () => {
		assert.equal(mod.classifyState(rec({ recordType: "run_log", status: "blocked" })), "blocked");
	});
	it("A1-2: pending status or pending_authorisation type → pending_authorisation", () => {
		assert.equal(mod.classifyState(rec({ recordType: "action_record", status: "pending_authorisation" })), "pending_authorisation");
		assert.equal(mod.classifyState(rec({ recordType: "pending_authorisation", status: "in_progress" })), "pending_authorisation");
	});
	it("A1-3: authorisation_record approved → continueable (router owns continuation)", () => {
		assert.equal(mod.classifyState(rec({ recordType: "authorisation_record", status: "approved", owner: "dispatcher" })), "continueable");
	});
	it("A1-4: authorisation_record deferred → stays pending_authorisation", () => {
		assert.equal(mod.classifyState(rec({ recordType: "authorisation_record", status: "deferred", owner: "dispatcher" })), "pending_authorisation");
	});
	it("A1-5: archival_record → closed", () => {
		assert.equal(mod.classifyState(rec({ recordType: "archival_record", status: "completed", owner: "archivist", stage: "recording_and_archival" })), "closed");
	});
	it("A1-6: archivist hand-off WITH prior archival → closed", () => {
		assert.equal(mod.classifyState(rec({ recordType: "hand_off_record", owner: "archivist", stage: "hand_off_or_closure" }), true), "closed");
	});
	it("A1-7: archivist hand-off WITHOUT archival → continueable (mid-flight, not closure)", () => {
		assert.equal(mod.classifyState(rec({ recordType: "hand_off_record", owner: "archivist", stage: "hand_off_or_closure" }), false), "continueable");
	});
	it("A1-8: any-role hand-off at the closure stage AFTER archival → closed (closure confirmation)", () => {
		assert.equal(mod.classifyState(rec({ recordType: "hand_off_record", owner: "researcher", stage: "hand_off_or_closure" }), true), "closed");
		assert.equal(mod.classifyState(rec({ recordType: "hand_off_record", owner: "router", stage: "hand_off_or_closure" }), true), "closed");
	});
	it("A1-8b: hand-off at a WORK stage after archival → continueable (rework routing, not closure)", () => {
		assert.equal(mod.classifyState(rec({ recordType: "hand_off_record", owner: "router", stage: "routing_and_assignment" }), true), "continueable");
		assert.equal(mod.classifyState(rec({ recordType: "hand_off_record", owner: "verifier", stage: "verification" }), true), "continueable");
	});
	it("A1-8c: post-closure router run_log at the closure stage → closed (atp-setup-env-hazard shape)", () => {
		assert.equal(mod.classifyState(rec({ recordType: "run_log", owner: "router", stage: "hand_off_or_closure", status: "completed" }), true), "closed");
	});
	it("A1-8d: post-closure run_log at a work stage → continueable (conservative)", () => {
		assert.equal(mod.classifyState(rec({ recordType: "run_log", owner: "builder", stage: "action", status: "in_progress" }), true), "continueable");
	});
	it("A1-9: verdict green → active (→ archivist)", () => {
		assert.equal(mod.classifyState(rec({ recordType: "verdict", status: "green", owner: "verifier", stage: "verification" })), "active");
	});
	it("A1-10: verdict red → continueable (→ rework)", () => {
		assert.equal(mod.classifyState(rec({ recordType: "verdict", status: "red", owner: "verifier", stage: "verification" })), "continueable");
	});
	it("A1-11: verdict with blocked status → blocked", () => {
		assert.equal(mod.classifyState(rec({ recordType: "verdict", status: "blocked", owner: "verifier", stage: "verification" })), "blocked");
	});
	it("A1-12: recording_and_archival stage (non-terminal record) → active", () => {
		assert.equal(mod.classifyState(rec({ recordType: "run_log", status: "in_progress", stage: "recording_and_archival", owner: "archivist" })), "active");
	});
	it("A1-13: unknown record falls through → continueable, never silently closed", () => {
		assert.equal(mod.classifyState(rec({ recordType: "run_log", status: "in_progress", stage: "action" })), "continueable");
		assert.equal(mod.classifyState(rec({ recordType: "escalation_record", status: "in_progress", stage: "action", owner: "dispatcher" })), "continueable");
	});
});

describe("A2: summarizeGoals — latest-record selection, filters, in-flight hand-offs", () => {
	const mk = (over: Parameters<typeof fixtureRecord>[0]) => mod.parseRecord(fixtureRecord(over))!;

	it("A2-1: latest record per goal chosen by createdAt desc", () => {
		const [summary] = mod.summarizeGoals([
			mk({ recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", createdAt: FIXTURE_BASE_TS + 1 }),
			mk({ recordType: "action_record", stage: "action", owner: "builder", createdAt: FIXTURE_BASE_TS + 3 }),
		]);
		assert.equal(summary.recordType, "action_record");
		assert.equal(summary.owner, "builder");
	});

	it("A2-2: equal-timestamp tie-break is deterministic — newest-inserted (SQL rowid order) wins", () => {
		const newer = mk({ recordType: "pending_authorisation", stage: "pending_authorisation", owner: "runtime", status: "pending_authorisation", createdAt: FIXTURE_BASE_TS + 5 });
		const older = mk({ recordType: "action_record", stage: "action", owner: "builder", status: "completed", createdAt: FIXTURE_BASE_TS + 5 });
		// SQL delivers records newest-inserted-first on ties; the sort must keep that order
		const [summary] = mod.summarizeGoals([newer, older]);
		assert.equal(summary.latestRecordId, newer.id);
		assert.equal(summary.state, "pending_authorisation");
	});

	it("A2-3: steer_request records are excluded from lifecycle state entirely", () => {
		const [summary] = mod.summarizeGoals([
			mk({ recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", createdAt: FIXTURE_BASE_TS + 1 }),
			mk({ recordType: "action_record", stage: "action", owner: "builder", createdAt: FIXTURE_BASE_TS + 2 }),
			mk({ recordType: "steer_request", stage: "action", owner: "builder", createdAt: FIXTURE_BASE_TS + 3 }),
		]);
		assert.equal(summary.recordType, "action_record", "steer must not become the latest record");
		assert.equal(summary.recordCount, 2, "steer not counted as lifecycle record");
	});

	it("A2-4: goalId filter keeps only that goal's records", () => {
		const other = "22222222-2222-4222-8222-222222222222";
		const goals = mod.summarizeGoals(
			[
				mk({ goalId: TEST_GOAL, createdAt: FIXTURE_BASE_TS + 1 }),
				mk({ goalId: other, createdAt: FIXTURE_BASE_TS + 2 }),
			],
			{ goalId: TEST_GOAL },
		);
		assert.equal(goals.length, 1);
		assert.equal(goals[0].goalId, TEST_GOAL);
	});

	it("A2-5: role filter matches agentId OR owner", () => {
		const run = mk({ recordType: "run_log", owner: "runtime", agentId: "verifier", createdAt: FIXTURE_BASE_TS + 1 });
		assert.equal(mod.summarizeGoals([run], { role: "verifier" }).length, 1, "matches agent_id");
		assert.equal(mod.summarizeGoals([run], { role: "runtime" }).length, 1, "matches owner_role");
		assert.equal(mod.summarizeGoals([run], { role: "builder" }).length, 0);
	});

	it("A2-6: in-flight hand-off to a known role with no later record → nextOwner set", () => {
		const [summary] = mod.summarizeGoals([
			mk({ recordType: "hand_off_record", stage: "hand_off_or_closure", owner: "researcher", createdAt: FIXTURE_BASE_TS + 2, metadata: { next_role: "builder" } }),
			mk({ recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", createdAt: FIXTURE_BASE_TS + 1 }),
		]);
		assert.equal(summary.nextOwner, "builder");
		assert.equal(summary.owner, "researcher", "handing-off role still the recorded owner");
	});

	it("A2-7: hand-off target already produced a later record → no nextOwner", () => {
		const [summary] = mod.summarizeGoals([
			mk({ recordType: "action_record", stage: "action", owner: "builder", createdAt: FIXTURE_BASE_TS + 3 }),
			mk({ recordType: "hand_off_record", stage: "hand_off_or_closure", owner: "researcher", createdAt: FIXTURE_BASE_TS + 2, metadata: { next_role: "builder" } }),
			mk({ recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", createdAt: FIXTURE_BASE_TS + 1 }),
		]);
		assert.equal(summary.nextOwner, undefined);
	});

	it("A2-8: hand-off next_role equal to its own owner → no nextOwner", () => {
		const [summary] = mod.summarizeGoals([
			mk({ recordType: "hand_off_record", stage: "hand_off_or_closure", owner: "builder", createdAt: FIXTURE_BASE_TS + 2, metadata: { next_role: "builder" } }),
		]);
		assert.equal(summary.nextOwner, undefined);
	});

	it("A2-9: junk next_role (e.g. 'closure') is not an activation", () => {
		const [summary] = mod.summarizeGoals([
			mk({ recordType: "hand_off_record", stage: "hand_off_or_closure", owner: "archivist", createdAt: FIXTURE_BASE_TS + 2, metadata: { next_role: "closure" } }),
		]);
		assert.equal(summary.nextOwner, undefined);
	});

	it("A2-10: closed goals never get nextOwner (closure hand-off is not an activation)", () => {
		const [summary] = mod.summarizeGoals([
			mk({ recordType: "archival_record", stage: "recording_and_archival", owner: "archivist", status: "completed", createdAt: FIXTURE_BASE_TS + 3 }),
			mk({ recordType: "hand_off_record", stage: "hand_off_or_closure", owner: "archivist", createdAt: FIXTURE_BASE_TS + 2, metadata: { next_role: "router" } }),
			mk({ recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", createdAt: FIXTURE_BASE_TS + 1 }),
		]);
		assert.equal(summary.state, "closed");
		assert.equal(summary.nextOwner, undefined);
	});

	it("A2-11: stageLabel — closed → Closure, hand-off stage → Hand-off, else humanized", () => {
		const [closed] = mod.summarizeGoals([
			mk({ recordType: "archival_record", stage: "recording_and_archival", owner: "archivist", status: "completed", createdAt: FIXTURE_BASE_TS + 2 }),
		]);
		assert.equal(closed.stageLabel, "Closure");
		const [handoff] = mod.summarizeGoals([
			mk({ recordType: "hand_off_record", stage: "hand_off_or_closure", owner: "researcher", createdAt: FIXTURE_BASE_TS + 2 }),
		]);
		assert.equal(handoff.stageLabel, "Hand-off");
		const [action] = mod.summarizeGoals([mk({ recordType: "action_record", stage: "context_gathering", owner: "researcher" })]);
		assert.equal(action.stageLabel, "Context gathering");
	});

	it("A2-12: goal title from goal_record JSON body; fallback prettifies the id", () => {
		const goalA = "33333333-3333-4333-8333-333333333333";
		mod.summarizeGoals([
			mk({
				goalId: goalA,
				recordType: "goal_record",
				stage: "goal_receipt",
				owner: "dispatcher",
				body: '{"requester":"user","title":"Ship the ATP test suite"}',
			}),
		]);
		assert.equal(mod.displayGoal(goalA), "Ship the ATP test suite");
		// goal without a title → id prettified (leading atp- and trailing date stripped)
		const plain = mod.summarizeGoals([mk({ goalId: "atp-smoke-defect-fixes-p1-2026-09-05" })])[0]!;
		assert.equal(mod.displayGoal(plain.goalId), "Smoke Defect Fixes P1");
	});

	it("A2-13: summaries sorted newest-first; recordCount reflects lifecycle records", () => {
		const goalA = "44444444-4444-4444-8444-444444444444";
		const goalB = "55555555-5555-4555-8555-555555555555";
		const summaries = mod.summarizeGoals([
			mk({ goalId: goalB, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", createdAt: FIXTURE_BASE_TS + 1 }),
			mk({ goalId: goalA, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", createdAt: FIXTURE_BASE_TS + 2 }),
		]);
		assert.equal(summaries[0].goalId, goalA, "newest goal first");
		assert.equal(summaries[0].recordCount, 1);
	});

	it("A2-14: post-closure router bookkeeping renders closed, not continueable (real-goal regression shapes)", () => {
		// atp-merge-setup-env-hazard shape: archival → archivist hand-off → router CLOSURE run_log
		const [mergeGoal] = mod.summarizeGoals([
			mk({ recordType: "run_log", stage: "hand_off_or_closure", owner: "router", status: "completed", createdAt: FIXTURE_BASE_TS + 4 }),
			mk({ recordType: "hand_off_record", stage: "hand_off_or_closure", owner: "archivist", createdAt: FIXTURE_BASE_TS + 3 }),
			mk({ recordType: "archival_record", stage: "recording_and_archival", owner: "archivist", status: "completed", createdAt: FIXTURE_BASE_TS + 2 }),
			mk({ recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", createdAt: FIXTURE_BASE_TS + 1 }),
		]);
		assert.equal(mergeGoal.state, "closed", "router closure run_log must not reopen an archived goal");
		// atp-workspace-cleanup shape: archival → … → router run_log → router closure hand-off
		const [cleanupGoal] = mod.summarizeGoals([
			mk({ recordType: "hand_off_record", stage: "hand_off_or_closure", owner: "router", createdAt: FIXTURE_BASE_TS + 6 }),
			mk({ recordType: "run_log", stage: "hand_off_or_closure", owner: "router", status: "completed", createdAt: FIXTURE_BASE_TS + 5 }),
			mk({ recordType: "hand_off_record", stage: "hand_off_or_closure", owner: "archivist", createdAt: FIXTURE_BASE_TS + 4 }),
			mk({ recordType: "archival_record", stage: "recording_and_archival", owner: "archivist", status: "completed", createdAt: FIXTURE_BASE_TS + 3 }),
			mk({ recordType: "verdict", stage: "verification", owner: "verifier", status: "green", createdAt: FIXTURE_BASE_TS + 2 }),
			mk({ recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", createdAt: FIXTURE_BASE_TS + 1 }),
		]);
		assert.equal(cleanupGoal.state, "closed", "router closure hand-off must not reopen an archived goal");
		assert.equal(cleanupGoal.stageLabel, "Closure");
	});
});

describe("A3: stranded pending after closure (F4)", () => {
	const mk = (over: Parameters<typeof fixtureRecord>[0]) => mod.parseRecord(fixtureRecord(over))!;

	it("A3-1: open pending record on a CLOSED goal is surfaced with its body as the question", () => {
		const pending = mk({
			recordType: "pending_authorisation",
			stage: "pending_authorisation",
			owner: "runtime",
			status: "pending_authorisation",
			body: "wipe the production table — approve?",
			createdAt: FIXTURE_BASE_TS + 1,
		});
		const archival = mk({ recordType: "archival_record", owner: "archivist", status: "completed", createdAt: FIXTURE_BASE_TS + 2 });
		const goals = mod.summarizeGoals([archival, pending]);
		const stranded = mod.findStrandedPending([archival, pending], goals);
		assert.equal(stranded.length, 1);
		assert.equal(stranded[0].recordId, pending.id);
		assert.ok(stranded[0].question.includes("production table"));
	});

	it("A3-2: pending resolved by a later authorisation_record is NOT stranded", () => {
		const pending = mk({ recordType: "pending_authorisation", owner: "runtime", status: "pending_authorisation", createdAt: FIXTURE_BASE_TS + 1 });
		const decided = mk({ recordType: "authorisation_record", owner: "dispatcher", status: "approved", createdAt: FIXTURE_BASE_TS + 2 });
		const archival = mk({ recordType: "archival_record", owner: "archivist", status: "completed", createdAt: FIXTURE_BASE_TS + 3 });
		const goals = mod.summarizeGoals([archival, decided, pending]);
		assert.equal(mod.findStrandedPending([archival, decided, pending], goals).length, 0);
	});

	it("A3-3: authorisation_record itself is never an open item", () => {
		const decided = mk({ recordType: "authorisation_record", owner: "dispatcher", status: "approved" });
		assert.equal(mod.isPendingItem(decided), false);
	});

	it("A3-4: only the latest pending item per goal is reported", () => {
		const p1 = mk({ recordType: "pending_authorisation", owner: "runtime", status: "pending_authorisation", createdAt: FIXTURE_BASE_TS + 1 });
		const p2 = mk({ recordType: "pending_authorisation", owner: "runtime", status: "pending_authorisation", createdAt: FIXTURE_BASE_TS + 2 });
		const archival = mk({ recordType: "archival_record", owner: "archivist", status: "completed", createdAt: FIXTURE_BASE_TS + 3 });
		const stranded = mod.findStrandedPending([archival, p2, p1], mod.summarizeGoals([archival, p2, p1]));
		assert.equal(stranded.length, 1);
		assert.equal(stranded[0].recordId, p2.id);
	});

	it("A3-5: items on non-closed goals are not duplicated into the stranded list", () => {
		const pending = mk({ recordType: "pending_authorisation", owner: "runtime", status: "pending_authorisation", createdAt: FIXTURE_BASE_TS + 2 });
		const goal = mk({ recordType: "goal_record", owner: "dispatcher", createdAt: FIXTURE_BASE_TS + 1 });
		const goals = mod.summarizeGoals([pending, goal]);
		assert.equal(goals[0].state, "pending_authorisation", "surfaces via goal state");
		assert.equal(mod.findStrandedPending([pending, goal], goals).length, 0);
	});

	it("A3-6: stranded list sorted by goalId", () => {
		const goalA = "66666666-6666-4666-8666-666666666666";
		const goalB = "77777777-7777-4777-8777-777777777777";
		const recs = [
			mk({ goalId: goalB, recordType: "pending_authorisation", owner: "runtime", status: "pending_authorisation", createdAt: FIXTURE_BASE_TS + 1 }),
			mk({ goalId: goalB, recordType: "archival_record", owner: "archivist", status: "completed", createdAt: FIXTURE_BASE_TS + 2 }),
			mk({ goalId: goalA, recordType: "pending_authorisation", owner: "runtime", status: "pending_authorisation", createdAt: FIXTURE_BASE_TS + 1 }),
			mk({ goalId: goalA, recordType: "archival_record", owner: "archivist", status: "completed", createdAt: FIXTURE_BASE_TS + 2 }),
		];
		const stranded = mod.findStrandedPending(recs, mod.summarizeGoals(recs));
		assert.equal(stranded.length, 2);
		assert.deepEqual(stranded.map((s: any) => s.goalId), [goalA, goalB]);
	});
});

describe("A4: record schema & identity lines", () => {
	it("A4-1: identity line parsed when metadata is empty (older raw-CLI records)", () => {
		const row = {
			...fixtureRecord({}),
			metadata: "{}",
			content: "Goal: 88888888-8888-4888-8888-888888888888 | Record ID: some-id | Stage: verification | Owner: verifier\nbody text",
		};
		const rec = mod.parseRecord(row)!;
		assert.ok(rec, "identity line makes it an ATP record");
		assert.equal(rec.goalId, "88888888-8888-4888-8888-888888888888");
		assert.equal(rec.stage, "verification");
		assert.equal(rec.owner, "verifier");
	});

	it("A4-2: parseMetadata tolerates null, invalid JSON, and non-object scalars", () => {
		assert.deepEqual(mod.parseMetadata(null), {});
		assert.deepEqual(mod.parseMetadata(undefined), {});
		assert.deepEqual(mod.parseMetadata("not json"), {});
		assert.deepEqual(mod.parseMetadata("42"), {});
		assert.deepEqual(mod.parseMetadata('{"goal_id":"g"}'), { goal_id: "g" });
	});

	it("A4-3: stripIdentity drops the identity line, keeps prose (incl. inline prose)", () => {
		assert.equal(mod.stripIdentity("Goal: g | Stage: s | Owner: o\nreal body"), "real body");
		assert.equal(mod.stripIdentity("Goal: g | Stage: s | Owner: o — CLOSURE RUN_LOG: done"), "CLOSURE RUN_LOG: done");
		assert.equal(mod.stripIdentity("no identity here"), "no identity here");
	});

	it("A4-4: unwrapJsonBlob renders prose keys first, scalar extras after, passthrough otherwise", () => {
		assert.equal(mod.unwrapJsonBlob('{"note":"did the thing","retries":3}'), "did the thing\nretries=3");
		assert.equal(mod.unwrapJsonBlob("plain text"), "plain text");
		assert.equal(mod.unwrapJsonBlob("[1,2]"), "[1,2]");
	});

	it("A4-5: humanizeBody strips identity then unwraps whole-body or per-line JSON blobs", () => {
		assert.equal(mod.humanizeBody("Goal: g | Stage: s | Owner: o\n" + '{"note":"shipped"}'), "shipped");
		// blob-first body without a JSON end: each standalone JSON-object line unwrapped
		assert.equal(mod.humanizeBody("Goal: g | Stage: s | Owner: o\n" + '{"note":"shipped"}\ntrailing prose'), "shipped\ntrailing prose");
		// prose body passes through untouched (per-line unwrapping only for blob bodies)
		assert.equal(mod.humanizeBody("Goal: g | Stage: s | Owner: o\nprose\n" + '{"note":"kept as-is"}'), 'prose\n{"note":"kept as-is"}');
	});

	it("A4-6: extractGoalTitle reads the JSON title key, clipped; empty when absent", () => {
		const withTitle = mod.parseRecord(
			fixtureRecord({ recordType: "goal_record", owner: "dispatcher", body: '{"title":"A very long goal title that goes on and on and definitely exceeds sixty characters total"}' }),
		)!;
		assert.ok(mod.extractGoalTitle(withTitle).length <= 60);
		assert.ok(mod.extractGoalTitle(withTitle).startsWith("A very long goal title"));
		const noTitle = mod.parseRecord(fixtureRecord({ recordType: "goal_record", owner: "dispatcher", body: "plain prose" }))!;
		assert.equal(mod.extractGoalTitle(noTitle), "");
	});
});

describe("A5: record-type discipline (F5a)", () => {
	it("A5-1: parked high-risk action recorded as pending_authorisation never reads active", () => {
		const parked = mod.parseRecord(
			fixtureRecord({ recordType: "pending_authorisation", stage: "action", owner: "runtime", status: "pending_authorisation", body: "prepared: rotate credentials" }),
		)!;
		assert.equal(mod.classifyState(parked, false), "pending_authorisation");
		assert.equal(mod.classifyState(parked, true), "pending_authorisation");
	});

	it("A5-2: a completed action_record routes to verification, never mistaken for parked action", () => {
		const done = mod.parseRecord(
			fixtureRecord({ recordType: "action_record", stage: "action", owner: "builder", status: "completed", body: "did the work" }),
		)!;
		assert.equal(mod.classifyState(done), "continueable");
		assert.notEqual(mod.classifyState(done), "pending_authorisation");
	});
});
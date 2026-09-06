/**
 * F7 — closed-goal removal (team_purge tool + /team-purge command):
 * closed goals stop occupying the default board views (widget /team-board
 * count line, team_status hidden count) and are durably removable under the
 * F1 cleanup discipline — dry-run preview, per-id lookup verification, a
 * purge-audit cleanup_record that cannot resurrect the goal on the board,
 * soft-delete forgets, and refusal of non-closed / stranded-pending goals.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	TEST_GOAL,
	TEST_WS,
	createFixtureDb,
	createMockCtx,
	fixtureRecord,
	importExtension,
	installFixtureBin,
	loadExtension,
	readArgvLog,
	testEnv,
	withEnv,
} from "./harness.ts";

const mod = await importExtension();
const OTHER_GOAL = "22222222-2222-4222-8222-222222222222";
const STRANDED_GOAL = "33333333-3333-4333-8333-333333333333";

/** A fully closed goal: goal_record + action_record + archival_record. */
function closedGoal(goalId = TEST_GOAL, createdAt = 1_760_000_001) {
	return [
		fixtureRecord({ goalId, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", body: '{"title":"Old Goal"}', createdAt }),
		fixtureRecord({ goalId, recordType: "action_record", stage: "action", owner: "builder", status: "completed", createdAt: createdAt + 1 }),
		fixtureRecord({ goalId, recordType: "archival_record", owner: "archivist", status: "completed", createdAt: createdAt + 2 }),
	];
}

/** Canned lookup reply that verifies every id as belonging to TEST_GOAL. */
const LOOKUP_OK = JSON.stringify({
	found: true,
	id: "x",
	metadata: { goal_id: TEST_GOAL },
	content: `Goal: ${TEST_GOAL} | Stage: action | Owner: builder`,
});

function argvOf(entry: { argv: string[] }, sub: string): string[] {
	const i = entry.argv.indexOf(sub);
	return i === -1 ? [] : entry.argv.slice(i);
}

function flagValue(argv: string[], flag: string): string {
	const i = argv.indexOf(flag);
	return i === -1 ? "" : (argv[i + 1] ?? "");
}

describe("F7-1: dry-run preview — lists targets, touches nothing", () => {
	it("dry_run: true lists the closed goal with record counts; no remember/forget calls", async () => {
		const db = createFixtureDb(closedGoal());
		try {
			const { binPath, logPath, dispose } = installFixtureBin();
			try {
				await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath }), async () => {
					const { tools } = await loadExtension();
					const { ctx } = createMockCtx();
					const res = (await tools.get("team_purge")!.execute("f7", { dry_run: true }, undefined, () => {}, ctx))
						.details as any;
					assert.equal(res.ok, true);
					assert.equal(res.dryRun, true);
					assert.equal(res.targets.length, 1);
					assert.equal(res.targets[0].goalId, TEST_GOAL);
					assert.equal(res.targets[0].recordCount, 3);
					assert.ok(res.targets[0].archivalRecordId, "archival record id reported");
					assert.ok(res.targets[0].title.includes("Old Goal"), "title from goal_record");
					const log = await readArgvLog(logPath);
					assert.ok(log.every((e) => !e.argv.includes("forget")), "no forget in dry run");
					assert.ok(log.every((e) => !e.argv.includes("remember")), "no audit write in dry run");
				});
			} finally {
				dispose();
			}
		} finally {
			db.dispose();
		}
	});

	it("no selector → actionable error; unknown/ambiguous prefixes → loud errors", async () => {
		const db = createFixtureDb([...closedGoal(), ...closedGoal(OTHER_GOAL, 1_760_010_001)]);
		try {
			const { binPath, logPath, dispose } = installFixtureBin();
			try {
				await withEnv(testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath }), async () => {
					const { tools } = await loadExtension();
					const { ctx } = createMockCtx();
					const none = (await tools.get("team_purge")!.execute("f7", {}, undefined, () => {}, ctx)).details as any;
					assert.ok(none.error.includes("goal_id"), "no-selector error names the params");
					const unknown = (
						await tools.get("team_purge")!.execute("f7", { goal_id: "nope" }, undefined, () => {}, ctx)
					).details as any;
					assert.ok(unknown.error.includes("No goal matching"), "unknown id error");
					const ambiguous = (
						await tools.get("team_purge")!.execute("f7", { goal_id: "old" }, undefined, () => {}, ctx)
					).details as any;
					// both goals carry the goal_record title "Old Goal" → prefix matches both
					assert.ok(ambiguous.error.includes("matches multiple goals"), "ambiguous prefix refused");
				});
			} finally {
				dispose();
			}
		} finally {
			db.dispose();
		}
	});
});

describe("F7-2: real purge — per-id verification, audit record, soft-delete forgets", () => {
	it("forgets lookup-verified ids; audit stored before, outcome folded in after", async () => {
		const db = createFixtureDb(closedGoal());
		try {
			const { binPath, logPath, dispose } = installFixtureBin();
			try {
				await withEnv(
					testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath, EDEN_FIXTURE_LOOKUP_DB: db.dbPath }),
					async () => {
						const { tools } = await loadExtension();
						const { ctx } = createMockCtx();
						const res = (await tools.get("team_purge")!.execute("f7", { goal_id: TEST_GOAL }, undefined, () => {}, ctx))
							.details as any;
						assert.equal(res.ok, true);
						assert.equal(res.dryRun, false);
						assert.equal(res.outcomes.length, 1);
						assert.equal(res.outcomes[0].forgottenIds.length, 3, "all verified ids forgotten");
						assert.equal(res.outcomes[0].retainedIds.length, 0);
						assert.ok(res.outcomes[0].auditRecordId, "audit record id returned");

						const log = await readArgvLog(logPath);
						const remembers = log.map((e, i) => ({ e, i })).filter(({ e }) => e.argv.includes("remember"));
						const forgets = log.map((e, i) => ({ e, i })).filter(({ e }) => e.argv.includes("forget"));
						const edits = log.map((e, i) => ({ e, i })).filter(({ e }) => e.argv.includes("edit"));
						assert.equal(remembers.length, 1, "exactly one audit remember");
						assert.equal(forgets.length, 3, "one forget per verified record");
						assert.equal(edits.length, 1, "outcome folded into the audit record");
						// ordering: audit BEFORE the forgets, edit AFTER
						assert.ok(remembers[0].i < forgets[0].i, "audit written before any forget");
						assert.ok(edits[0].i > forgets[2].i, "outcome edit after the last forget");
						// each forget targets one of the goal's record ids
						const forgottenTargets = forgets.map(({ e }) => flagValue(e.argv, "--id")).sort();
						const goalRecordIds = res.targets[0].recordIds.slice().sort();
						assert.deepEqual(forgottenTargets, goalRecordIds);

						// Audit record guards: no goal_id metadata key, no "Goal:" identity
						// line (either would resurrect the goal as a board row).
						const rememberArgv = remembers[0].e.argv;
						const auditContent = flagValue(rememberArgv, "--content");
						const auditMetadata = JSON.parse(flagValue(rememberArgv, "--metadata"));
						assert.ok(auditContent.includes("PURGE AUDIT"), "audit identity");
						assert.ok(auditContent.includes(TEST_GOAL), "goal id searchable in content");
						assert.ok(!auditMetadata.goal_id, "no goal_id metadata key");
						assert.equal(auditMetadata.record_type, "cleanup_record");
						assert.equal(auditMetadata.purged_goal_id, TEST_GOAL);
						assert.ok(!/^Goal:/m.test(auditContent), "no Goal: identity line in audit content");
						// Resurrection guard: the audit record parses as NOT an ATP goal row.
						const row = {
							id: "audit-1",
							agent_id: "archivist",
							content: auditContent,
							created_at: 1_760_000_099,
							metadata: JSON.stringify(auditMetadata),
						};
						assert.equal(mod.parseRecord(row as any), null, "audit record cannot resurrect the goal");
					});
			} finally {
				dispose();
			}
		} finally {
			db.dispose();
		}
	});

	it("lookup-unverified ids are retained, never forgotten (F1 point 3)", async () => {
		const db = createFixtureDb(closedGoal());
		try {
			const { binPath, logPath, dispose } = installFixtureBin();
			try {
				await withEnv(
					testEnv({
						EDEN_MEMORY_BIN: binPath,
						EDEN_MEMORY_DB: db.dbPath,
						EDEN_FIXTURE_LOG: logPath,
						EDEN_FIXTURE_LOOKUP_JSON: JSON.stringify({ found: false }),
					}),
					async () => {
						const { tools } = await loadExtension();
						const { ctx } = createMockCtx();
						const res = (await tools.get("team_purge")!.execute("f7", { goal_id: TEST_GOAL }, undefined, () => {}, ctx))
							.details as any;
						assert.equal(res.outcomes[0].forgottenIds.length, 0, "nothing forgotten");
						assert.equal(res.outcomes[0].retainedIds.length, 3, "all ids retained");
						const log = await readArgvLog(logPath);
						assert.ok(log.every((e) => !e.argv.includes("forget")), "no forget calls for unverified ids");
					},
				);
			} finally {
				dispose();
			}
		} finally {
			db.dispose();
		}
	});
});

describe("F7-3: skips — not closed / stranded pending (closure disposition rule)", () => {
	function strandedClosed() {
		// Pending item BEFORE the archival record → goal state is closed (latest
		// record) while the pending item remains unresolved — the F4 stranded case.
		return [
			fixtureRecord({ goalId: STRANDED_GOAL, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", body: '{"title":"Stranded Goal"}', createdAt: 1_760_020_001 }),
			fixtureRecord({ goalId: STRANDED_GOAL, recordType: "pending_authorisation", stage: "pending_authorisation", owner: "runtime", status: "pending_authorisation", body: "wipe the table — approve?", createdAt: 1_760_020_002 }),
			fixtureRecord({ goalId: STRANDED_GOAL, recordType: "archival_record", owner: "archivist", status: "completed", createdAt: 1_760_020_003 }),
		];
	}

	it("all: true purges closed goals but skips open + stranded ones; single-goal purge of a non-closed goal is refused", async () => {
		const db = createFixtureDb([...openGoalPending(), ...strandedClosed()]);
		try {
			const { binPath, logPath, dispose } = installFixtureBin();
			try {
				await withEnv(
					testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath, EDEN_FIXTURE_LOOKUP_JSON: LOOKUP_OK }),
					async () => {
						const { tools } = await loadExtension();
						const { ctx } = createMockCtx();
						const res = (await tools.get("team_purge")!.execute("f7", { all: true, dry_run: true }, undefined, () => {}, ctx))
							.details as any;
						assert.equal(res.targets.length, 0, "the only closed goal is stranded → nothing purgeable");
						// all: true selects closed goals only — open goals are not
						// candidates; the stranded closed goal is reported as a skip.
						assert.equal(res.skipped.length, 1);
						assert.ok(res.skipped.some((s: any) => s.goalId === STRANDED_GOAL && s.reason.includes("pending/blocked")));
						assert.ok(res.skipped.some((s: any) => s.reason.includes("team_decide")), "skip names the decision path");

						// single-goal purge of the open goal: skipped, nothing touched
						const res2 = (
							await tools.get("team_purge")!.execute("f7", { goal_id: OTHER_GOAL }, undefined, () => {}, ctx)
						).details as any;
						assert.equal(res2.targets.length, 0);
						assert.equal(res2.skipped.length, 1);
						const log = await readArgvLog(logPath);
						assert.ok(log.every((e) => !e.argv.includes("forget")), "no forget calls for skipped goals");
					},
				);
			} finally {
				dispose();
			}
		} finally {
			db.dispose();
		}
	});

	it("purgeable goal is purged alongside skipped ones when all: true", async () => {
		const open = openGoalPending("44444444-4444-4444-8444-444444444444");
		const db = createFixtureDb([...open, ...closedGoal(OTHER_GOAL, 1_760_021_001)]);
		try {
			const { binPath, logPath, dispose } = installFixtureBin();
			try {
				await withEnv(
					testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath, EDEN_FIXTURE_LOOKUP_DB: db.dbPath }),
					async () => {
						const { tools } = await loadExtension();
						const { ctx } = createMockCtx();
						const res = (await tools.get("team_purge")!.execute("f7", { all: true }, undefined, () => {}, ctx))
							.details as any;
						assert.equal(res.outcomes.length, 1);
						assert.equal(res.outcomes[0].goalId, OTHER_GOAL);
						assert.equal(res.skipped.length, 0, "open goals are not candidates, not skips");
						const log = await readArgvLog(logPath);
						const forgetIds = log.filter((e) => e.argv.includes("forget")).map((e) => flagValue(e.argv, "--id"));
						const openRecordIds = open.map((r) => String(r.id));
						assert.equal(forgetIds.length, 3, "only the closed goal's records forgotten");
						assert.ok(
							forgetIds.every((id: string) => !openRecordIds.includes(id)),
							"open goal's records untouched",
						);
					},
				);
			} finally {
				dispose();
			}
		} finally {
			db.dispose();
		}
	});

	function openGoalPending(goalId = OTHER_GOAL) {
		return [
			fixtureRecord({ goalId, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", body: '{"title":"Open Goal"}', createdAt: 1_760_022_001 }),
			fixtureRecord({ goalId, recordType: "pending_authorisation", stage: "pending_authorisation", owner: "builder", status: "pending_authorisation", body: "approve?", createdAt: 1_760_022_002 }),
		];
	}
});

describe("F7-4: /team-purge command + summary lines", () => {
	it("bare command = dry-run preview with follow-up hint; 'all' purges", async () => {
		const db = createFixtureDb(closedGoal());
		try {
			const { binPath, logPath, dispose } = installFixtureBin();
			try {
				await withEnv(
					testEnv({ EDEN_MEMORY_BIN: binPath, EDEN_MEMORY_DB: db.dbPath, EDEN_FIXTURE_LOG: logPath, EDEN_FIXTURE_LOOKUP_JSON: LOOKUP_OK }),
					async () => {
						const { commands } = await loadExtension();
						const { ctx, captured } = createMockCtx();
						await commands.get("team-purge")!.handler("", ctx);
						const dryMsgs = captured.notify.map((n: any) => n.msg).join("\n");
						assert.ok(dryMsgs.includes("dry run"), "bare command previews");
						assert.ok(dryMsgs.includes("Old Goal"), "preview names the goal");
						assert.ok(dryMsgs.includes("/team-purge all"), "follow-up hint");

						await commands.get("team-purge")!.handler("all", ctx);
						const allMsgs = captured.notify.map((n: any) => n.msg).join("\n");
						assert.ok(allMsgs.includes("✓ purged Old Goal"), "actual purge reported");
					},
				);
			} finally {
				dispose();
			}
		} finally {
			db.dispose();
		}
	});

	it("purgeSummaryLines: dry-run wording, skips, empty case", () => {
		const lines = mod.purgeSummaryLines({
			ok: true,
			dryRun: true,
			targets: [{ goalId: TEST_GOAL, title: "Old Goal", recordCount: 3, recordIds: [], archivalRecordId: "aaa" }],
			skipped: [{ goalId: OTHER_GOAL, reason: "goal state is active, not closed" }],
			outcomes: [],
		});
		const joined = lines.join("\n");
		assert.ok(joined.includes("○ would purge Old Goal — 3 record(s)"), "dry-run wording");
		assert.ok(joined.includes("archival rec aaa"), "archival reference");
		assert.ok(joined.includes("⚠ skipped"), "skip marker");
		assert.ok(joined.includes("goal state is active, not closed"), "skip reason");
		const empty = mod.purgeSummaryLines({ ok: true, dryRun: true, targets: [], skipped: [], outcomes: [] });
		assert.ok(empty.join("\n").includes("(no closed goals found)"));
	});
});
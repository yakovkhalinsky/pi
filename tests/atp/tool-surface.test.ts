/**
 * B5-1 + B5-2 — API-surface scope safety (F1): the tool surface exposes
 * exactly the seven team_* tools and three commands. Deletion is a
 * deliberate, narrow surface (team_purge, added 2026-09-06 per user request:
 * closed goals must be removable): single-goal or closed-goals-only bulk,
 * never workspace/agent-scope-wide. The B5-2 forbidden-regex guard stays.
 * The wrapper-level forget contract (B5-3) lives in genericity.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadExtension } from "./harness.ts";

const { tools, commands } = await loadExtension();

describe("B5-1: registered surface is exactly the seven team tools + three commands", () => {
	it("tool names are exactly the documented seven — no forget/vacuum/export surface", () => {
		assert.deepEqual(
			[...tools.keys()].sort(),
			["team_decide", "team_lookup", "team_purge", "team_recall", "team_remember", "team_status", "team_steer"],
		);
	});
	it("commands are exactly steer + team-board + team-purge", () => {
		assert.deepEqual([...commands.keys()].sort(), ["steer", "team-board", "team-purge"]);
	});
});

describe("B5-2: parameter schemas expose no scope-based deletion", () => {
	const EXPECTED: Record<string, string[]> = {
		team_status: ["goal_id", "role", "include_closed", "workspace"],
		team_recall: ["agent_id", "query", "limit", "workspace"],
		team_remember: ["agent_id", "goal_id", "stage", "owner_role", "record_type", "status", "body", "metadata", "workspace"],
		team_lookup: ["id", "workspace"],
		team_decide: ["goal_id", "decision", "note", "workspace"],
		team_steer: ["role", "message", "goal_id", "workspace"],
		// The sanctioned removal surface (2026-09-06): closed goals only,
		// single-goal or closed-goals bulk, never workspace/agent-scope-wide.
		team_purge: ["goal_id", "all", "dry_run", "workspace"],
	};

	it("every tool's parameters match the documented set exactly", () => {
		for (const [name, expected] of Object.entries(EXPECTED)) {
			const props = tools.get(name)!.parameters?.properties ?? {};
			assert.deepEqual(
				Object.keys(props).sort(),
				[...expected].sort(),
				`${name} parameter set`,
			);
		}
	});

	it("no parameter anywhere suggests destructive or scope-wide operations", () => {
		const forbidden = /forget|delete|vacuum|prune|wipe|purge|erase|all_records|scope/i;
		for (const [name, def] of tools) {
			for (const key of Object.keys(def.parameters?.properties ?? {})) {
				assert.ok(!forbidden.test(key), `${name}.${key} matches forbidden pattern ${forbidden}`);
			}
		}
	});

	it("the only bulk selector is team_purge.all, bounded to closed goals (F1)", () => {
		for (const [name, def] of tools) {
			const keys = Object.keys(def.parameters?.properties ?? {});
			if (keys.includes("all")) {
				assert.equal(name, "team_purge", `bulk 'all' param is only sanctioned on team_purge (found on ${name})`);
			}
		}
		// team_purge's removal is per-goal (goal_id) or closed-goals-only (all):
		// no workspace/agent/role-scoped deletion parameter may exist.
		const purgeKeys = Object.keys(tools.get("team_purge")!.parameters?.properties ?? {});
		for (const key of purgeKeys) assert.ok(!/agent|role/i.test(key), `team_purge.${key} would widen deletion scope`);
	});
});
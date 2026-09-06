/**
 * B5-1 + B5-2 — API-surface scope safety (F1): the tool surface exposes
 * exactly the six team_* tools and two commands, and no scope-based deletion.
 * The wrapper-level forget contract (B5-3) lives in genericity.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadExtension } from "./harness.ts";

const { tools, commands } = await loadExtension();

describe("B5-1: registered surface is exactly the six team tools + two commands", () => {
	it("tool names are exactly the documented six — no forget/vacuum/export surface", () => {
		assert.deepEqual(
			[...tools.keys()].sort(),
			["team_decide", "team_lookup", "team_recall", "team_remember", "team_status", "team_steer"],
		);
	});
	it("commands are exactly steer + team-board", () => {
		assert.deepEqual([...commands.keys()].sort(), ["steer", "team-board"]);
	});
});

describe("B5-2: parameter schemas expose no scope-based deletion", () => {
	const EXPECTED: Record<string, string[]> = {
		team_status: ["goal_id", "role", "workspace"],
		team_recall: ["agent_id", "query", "limit", "workspace"],
		team_remember: ["agent_id", "goal_id", "stage", "owner_role", "record_type", "status", "body", "metadata", "workspace"],
		team_lookup: ["id", "workspace"],
		team_decide: ["goal_id", "decision", "note", "workspace"],
		team_steer: ["role", "message", "goal_id", "workspace"],
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
});
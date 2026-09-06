/**
 * C1 + C6 — goal board rendering (T1): ANSI-aware column alignment, state
 * pills, badges, time formatting, truncation, in-flight hand-off owner column,
 * empty/filtered board messages, needs-you rows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
	TEST_GOAL,
	fixtureRecord,
	importExtension,
	createTheme,
	stripAnsi,
} from "./harness.ts";

const mod = await importExtension();
const NOW = Math.floor(Date.now() / 1000);

/** A fitting summary: recent, short title, small counts — every cell fits its column. */
function fittingSummary(over: any = {}) {
	return {
		goalId: TEST_GOAL,
		stage: "action",
		stageLabel: "Action",
		owner: over.nextOwner ? "runtime" : "builder",
		nextOwner: over.nextOwner,
		state: over.state ?? "pending_authorisation",
		recordType: "pending_authorisation",
		status: "pending_authorisation",
		latestRecordId: "aaaaaaaa-1111",
		latestBody: "question?",
		createdAt: NOW - 300,
		recordCount: 3,
		...over,
	};
}

describe("C1-1: board columns align (ANSI-aware)", () => {
	const plain = createTheme("passthrough");
	const ansi = createTheme("ansi");

	// Column layout: STATE(10) GOAL(36) STAGE(22) OWNER(12) RECORD(10) UPDATED(9) RECS(5), 2-space gaps.
	// Position-based checks: split-on-whitespace is unreliable because column
	// padding merges with the 2-space separators (and the last column is trimEnd()ed).
	const COL_STARTS = [0, 12, 50, 74, 88, 100, 111];
	const LABELS = ["STATE", "GOAL", "STAGE", "OWNER", "RECORD", "UPDATED", "RECS"];

	it("full board: every column starts at the same offset in header and row", () => {
		const header = stripAnsi(mod.boardHeader(plain, false));
		const row = stripAnsi(mod.boardRow(plain, fittingSummary(), false));
		for (const [i, label] of LABELS.entries()) assert.equal(header.indexOf(label), COL_STARTS[i], `${label} offset`);
		const expectedCells = ["[pending]", "11111111 1111", "Action", "builder", "aaaaaaaa-1", "5m ago", "(3)"];
		for (const [i, cell] of expectedCells.entries()) {
			assert.ok(row.slice(COL_STARTS[i]).startsWith(cell), `column ${i} (${LABELS[i]}) aligned: got ${JSON.stringify(row.slice(COL_STARTS[i], COL_STARTS[i] + 20))}`);
		}
		assert.ok(!row.includes("\n"), "single line, no wrap");
		// last column is trimEnd()ed on rows: row is shorter than the header by its padding
		assert.equal(row.length, 114);
		assert.equal(header.length, 116);
	});

	it("ANSI styling is transparent to content and width", () => {
		const ansiRow = mod.boardRow(ansi, fittingSummary(), false);
		const plainRow = mod.boardRow(plain, fittingSummary(), false);
		assert.equal(stripAnsi(ansiRow), plainRow, "ANSI stripping restores the exact plain row");
		assert.equal(visibleWidth(ansiRow), visibleWidth(plainRow), "visible width unaffected");
	});

	it("compact board (widget) drops RECORD/UPDATED columns", () => {
		const header = stripAnsi(mod.boardHeader(plain, true));
		for (const [i, label] of ["STATE", "GOAL", "STAGE", "OWNER"].entries()) assert.equal(header.indexOf(label), COL_STARTS[i]);
		const row = stripAnsi(mod.boardRow(plain, fittingSummary(), true));
		assert.ok(row.slice(0).startsWith("[pending]"));
		assert.ok(row.slice(12).startsWith("11111111 1111"));
		assert.ok(!row.includes("aaaaaaaa-1"), "record id dropped in compact mode");
		assert.ok(row.includes("(3)"), "counts kept");
	});
});

describe("C1-2: state pills per state", () => {
	const ansi = createTheme("ansi");
	const plain = createTheme("passthrough");
	const cases: [string, string, string][] = [
		["active", "[active]", "\x1b[36m"], // accent
		["blocked", "[blocked]", "\x1b[33m"], // warning
		["pending_authorisation", "[pending]", "\x1b[31m"], // error
		["continueable", "[continue]", "\x1b[90m"], // muted
		["closed", "[closed]", "\x1b[32m"], // success
	];
	for (const [state, label, code] of cases) {
		it(`stateTag(${state}) → ${label} in the right color`, () => {
			const tagged = mod.stateTag(ansi, state as any);
			assert.ok(tagged.startsWith(code), `colored with ${code}`);
			assert.ok(tagged.includes(label));
			assert.equal(stripAnsi(tagged), label);
			assert.equal(mod.stateTag(plain, state as any), label);
		});
	}
});

describe("C1-3: stage/owner badges with unknown-value fallback", () => {
	const ansi = createTheme("ansi");
	it("stageBadge humanizes snake_case stages", () => {
		assert.equal(stripAnsi(mod.stageBadge(ansi, "recording_and_archival")), "Recording and archival");
	});
	it("unknown stage still humanizes instead of crashing", () => {
		assert.equal(stripAnsi(mod.stageBadge(ansi, "weird_stage")), "Weird stage");
	});
	it("ownerBadge renders the role name", () => {
		assert.equal(stripAnsi(mod.ownerBadge(ansi, "archivist")), "archivist");
	});
});

describe("C1-4: time formatting", () => {
	it("relTime buckets: just now / Xm ago / Xh ago / Xd ago / absolute beyond 30d", () => {
		assert.equal(mod.relTime(NOW - 10), "just now");
		assert.equal(mod.relTime(NOW - 300), "5m ago");
		assert.equal(mod.relTime(NOW - 2 * 3600), "2h ago");
		assert.equal(mod.relTime(NOW - 3 * 86400), "3d ago");
		assert.match(mod.relTime(NOW - 40 * 86400), /^\d{2}-\d{2} \d{2}:\d{2}$/);
	});
	it("relTime is future-safe and zero-safe", () => {
		assert.equal(mod.relTime(NOW + 1000), "just now");
		assert.equal(mod.relTime(0), "—");
	});
	it("fmtTime renders MM-DD HH:MM from unix seconds; fmtStored handles all shapes", () => {
		assert.equal(mod.fmtTime(0), "—");
		assert.match(mod.fmtTime(1_760_000_000), /^\d{2}-\d{2} \d{2}:\d{2}$/);
		assert.match(mod.fmtStored(1_760_000_000), /^\d{2}-\d{2} \d{2}:\d{2}$/);
		assert.match(mod.fmtStored("2026-09-06T00:00:00Z"), /ago|just now/);
		assert.equal(mod.fmtStored(undefined), "—");
	});
});

describe("C1-5: displayGoal / shortId", () => {
	it("shortId truncates and dashes for empty ids", () => {
		assert.equal(mod.shortId("abcdefghijklmnop", 8), "abcdefgh");
		assert.equal(mod.shortId("", 8), "—");
	});
	it("displayGoal prefers the goal_record title, else prettifies the id", () => {
		mod.summarizeGoals([
			mod.parseRecord(
				fixtureRecord({ goalId: TEST_GOAL, recordType: "goal_record", owner: "dispatcher", body: '{"title":"Board Title Test"}' }),
			)!,
		]);
		assert.equal(mod.displayGoal(TEST_GOAL), "Board Title Test");
		assert.equal(mod.displayGoal("atp-my-goal-2026-01-02"), "My Goal");
	});
});

describe("C1-6: long titles truncate to the GOAL column, never wrap or bleed", () => {
	const plain = createTheme("passthrough");
	it("goalCol truncates to 36 visible chars", () => {
		const longTitle = "X".repeat(60);
		mod.summarizeGoals([
			mod.parseRecord(
				fixtureRecord({ goalId: TEST_GOAL, recordType: "goal_record", owner: "dispatcher", body: `{"title":"${longTitle}"}` }),
			)!,
		]);
		const cell = mod.goalCol(plain, TEST_GOAL, 36);
		assert.ok(visibleWidth(cell) <= 36, `truncated, got ${visibleWidth(cell)}`);
	});
	it("a full row with a long title truncates inside the GOAL column without bleeding into STAGE", () => {
		const row = stripAnsi(mod.boardRow(plain, fittingSummary(), false));
		const goalCell = row.slice(12, 48).trimEnd();
		assert.equal(goalCell.length, 36, "truncated to exactly the column width");
		assert.equal(row.slice(48, 50), "  ", "column gap intact — no bleed");
	});
});

describe("C1-7: in-flight hand-off renders the owner column as → role", () => {
	const plain = createTheme("passthrough");
	it("nextOwner renders with the arrow, aligned to the OWNER column", () => {
		const row = stripAnsi(mod.boardRow(plain, fittingSummary({ nextOwner: "builder" }), false));
		const ownerCell = row.slice(74, 86).trimEnd();
		assert.equal(ownerCell, "→ builder");
	});
});

describe("C6-1: empty & filtered board messages", () => {
	const plain = createTheme("passthrough");
	it("unfiltered empty board points at /team", () => {
		const lines = mod.emptyBoard(plain).map(stripAnsi);
		assert.equal(lines.length, 3);
		assert.ok(lines[0].includes("No active goals found in Eden-memory."));
		assert.ok(lines.join("\n").includes("/team <goal>"));
	});
	it("goal_id-filtered empty board names the goal", () => {
		const lines = mod.emptyBoard(plain, { goalId: TEST_GOAL }).map(stripAnsi);
		assert.equal(lines.length, 1);
		assert.ok(lines[0].includes(`No team records found for goal ${mod.displayGoal(TEST_GOAL)}`));
	});
	it("role-filtered empty board names the role", () => {
		const lines = mod.emptyBoard(plain, { role: "builder" }).map(stripAnsi);
		assert.ok(lines[0].includes("No team records found for role builder"));
	});
});

describe("needs-you rows (board render of pending + stranded)", () => {
	const plain = createTheme("passthrough");
	it("pending and stranded items render marks, question, and the decide command", () => {
		const pending = fittingSummary({ state: "pending_authorisation" });
		const stranded = { goalId: TEST_GOAL, recordId: "bbbbbbbb-2222", recordType: "pending_authorisation", question: "wipe prod?" };
		const lines = mod.needsYouRows(plain, [pending], [stranded]).map(stripAnsi);
		const joined = lines.join("\n");
		assert.ok(joined.includes("⚠ Needs you (2) — decide with /team-approve"));
		assert.ok(joined.includes("□ decide"), "pending marker");
		assert.ok(joined.includes("■ closed"), "stranded marker");
		assert.ok(joined.includes(`team_decide goal_id="${TEST_GOAL}"`));
		assert.ok(joined.includes("wipe prod?"));
	});
	it("no rows when nothing needs the human", () => {
		const active = fittingSummary({ state: "active" });
		assert.equal(mod.needsYouRows(plain, [active], []).length, 0);
	});
});
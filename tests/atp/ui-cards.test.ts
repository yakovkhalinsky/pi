/**
 * C3 + C4 + C5 — cards and expansion (renderResult tier, hand-built details,
 * no CLI needed): recall score badges, record card fields, decision card,
 * ctrl+o expanded vs collapsed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TEST_GOAL, createMockCtx, createTheme, importExtension, loadExtension, stripAnsi } from "./harness.ts";

const mod = await importExtension();
const ansi = createTheme("ansi");
const { ctx } = createMockCtx();
const { tools } = await loadExtension();

/** Render a component to plain text: ANSI stripped, trailing pad spaces removed. */
const renderPlain = (component: any, width: number): string =>
	component
		.render(width)
		.map((l: string) => stripAnsi(l).replace(/\s+$/, ""))
		.join("\n");

const identityContent = (body: string) => `Goal: ${TEST_GOAL} | Stage: action | Owner: builder\n${body}`;

describe("C3: scored match badges in team_recall renderResult", () => {
	const details = {
		results: [
			{ id: "aaaa-1111", score: 0.82, content: identityContent("high relevance match") },
			{ id: "aaaa-2222", score: 0.3, content: identityContent("low relevance match") },
			{ id: "aaaa-3333", content: identityContent("no score at all") },
		],
		workspace: "test-ws",
		workspaceSource: "env ATP_WORKSPACE_ID",
	};
	const result = { content: [], details };

	it("score ≥ 0.45 renders green (success); below and missing render dim", () => {
		const c = tools.get("team_recall")!.renderResult(result, { expanded: false }, ansi, ctx);
		const text = c.render(200).join("\n");
		assert.ok(text.includes("\x1b[32m[0.82]"), "high score in success color");
		assert.ok(text.includes("\x1b[2m[0.30]"), "low score dim");
		assert.ok(text.includes("\x1b[2m[—]"), "missing score dim em dash");
		assert.equal(stripAnsi(text).includes("[0.82]"), true);
	});

	it("match list carries stage/goal badges from the identity line; ctrl+o hint when collapsed", () => {
		const c = tools.get("team_recall")!.renderResult(result, { expanded: false }, ansi, ctx);
		const plain = renderPlain(c, 400);
		// NOTE: the renderResult badges are stage + goal; the owner badge is part of
		// the execute() text output (asserted in ui-text C2-4).
		assert.ok(plain.includes("Action"), "stage badge humanized");
		assert.ok(plain.includes(mod.displayGoal(TEST_GOAL)), "goal badge");
		assert.ok(plain.includes("(ctrl+o for longer snippets)"), "collapsed hint");
	});

	it("expanded: no ctrl+o hint, longer snippet (marker-based)", () => {
		// marker at char ~345: inside the expanded clip (400) but outside collapsed (96)
		const body = "w".repeat(340) + " TAILENDXYZ " + "w".repeat(200);
		const expandedDetails = {
			results: [{ id: "aaaa-4444", score: 0.9, content: identityContent(body) }],
			workspace: "test-ws",
		};
		const collapsed = renderPlain(tools.get("team_recall")!.renderResult({ content: [], details: expandedDetails }, { expanded: false }, ansi, ctx), 4000);
		const expanded = renderPlain(tools.get("team_recall")!.renderResult({ content: [], details: expandedDetails }, { expanded: true }, ansi, ctx), 4000);
		assert.ok(!expanded.includes("(ctrl+o"), "no hint when expanded");
		assert.ok(!collapsed.includes("TAILENDXYZ"), "collapsed snippet clipped before the marker");
		assert.ok(expanded.includes("TAILENDXYZ"), "expanded snippet reaches the marker");
		assert.ok(collapsed.length < expanded.length, "expanded carries a longer snippet");
	});
});

describe("C4-1: team_lookup record card fields", () => {
	const record = {
		id: "cccc-1234",
		content: identityContent("did the durable thing"),
		metadata: {
			stage: "action",
			owner_role: "builder",
			record_type: "action_record",
			status: "completed",
			goal_id: TEST_GOAL,
			stored_at: "2026-09-06T00:00:00Z",
			input_record_ids: ["11111111-22", "33333333-44"],
		},
	};
	const result = { content: [], details: { found: true, record, id: record.id } };

	it("card shows id, stage/owner/type/status/goal badges and the body", () => {
		const plain = renderPlain(tools.get("team_lookup")!.renderResult(result, { expanded: false }, ansi, ctx), 400);
		assert.ok(plain.includes("cccc-1234"), "record id");
		assert.ok(plain.includes("Action"), "stage badge");
		assert.ok(plain.includes("builder"), "owner badge");
		assert.ok(plain.includes("Action record"), "type humanized");
		assert.ok(plain.includes("● completed"), "status dot with color-neutral text");
		assert.ok(plain.includes(mod.displayGoal(TEST_GOAL)), "goal");
		assert.ok(plain.includes("did the durable thing"), "body");
	});

	it("expanded adds the extra metadata line; summarizeMetaValue shortens id arrays", () => {
		const plain = renderPlain(tools.get("team_lookup")!.renderResult(result, { expanded: true }, ansi, ctx), 400);
		assert.ok(plain.includes("metadata:"), "expanded metadata section");
		assert.ok(plain.includes("input_record_ids=11111111, 33333333"), "array values shortened via shortId(…, 8)");
	});

	it("not-found renders the dim placeholder", () => {
		const nf = { content: [], details: { found: false, id: "nope" } };
		const plain = renderPlain(tools.get("team_lookup")!.renderResult(nf, { expanded: false }, ansi, ctx), 200);
		assert.ok(plain.includes("Record not found"));
	});
});

describe("C4-2: team_decide decision card", () => {
	const mk = (decision: string, extra: any = {}) => ({
		content: [],
		details: { recordId: "dddd-1234", decision, goalId: TEST_GOAL, note: "user said yes", ...extra },
	});

	it("approve: green verb, goal, note, execution next step", () => {
		const plain = stripAnsi(tools.get("team_decide")!.renderResult(mk("approve"), { expanded: false }, ansi, ctx).render(300).join("\n"));
		assert.ok(plain.includes("✓ approved"));
		assert.ok(plain.includes("user said yes"));
		assert.ok(plain.includes("Next: spawn the router → owning role executes"));
		assert.ok(plain.includes(mod.displayGoal(TEST_GOAL)));
	});
	it("reject: error color verb and rework next step", () => {
		const plain = stripAnsi(tools.get("team_decide")!.renderResult(mk("reject", { note: "" }), { expanded: false }, ansi, ctx).render(300).join("\n"));
		assert.ok(plain.includes("✗ rejected"));
		assert.ok(plain.includes("Next: spawn the router → rework or closure"));
		assert.ok(!plain.includes("user said yes"), "empty note omitted");
	});
	it("defer: warning verb and stays-pending next step", () => {
		const plain = stripAnsi(tools.get("team_decide")!.renderResult(mk("defer", { note: "" }), { expanded: false }, ansi, ctx).render(300).join("\n"));
		assert.ok(plain.includes("⏸ deferred"));
		assert.ok(plain.includes("Stays pending_authorisation — still on the Needs-you list"));
	});
	it("closed-goal decision gets the post-closure next step", () => {
		const plain = stripAnsi(tools.get("team_decide")!.renderResult(mk("approve", { goalClosed: true, note: "" }), { expanded: false }, ansi, ctx).render(300).join("\n"));
		assert.ok(plain.includes("Goal already closed — the router decides how to continue"));
	});
});

describe("C5: ctrl+o expansion on team_lookup", () => {
	const longBody = "detail ".repeat(60); // ~420 chars
	const record = {
		id: "eeee-1234",
		content: identityContent(longBody),
		metadata: { stage: "action", owner_role: "builder", extra_key: "extra_value", goal_id: TEST_GOAL, status: "completed" },
	};
	const result = { content: [], details: { found: true, record, id: record.id } };

	it("collapsed clips the body (~160) and hides metadata", () => {
		const plain = renderPlain(tools.get("team_lookup")!.renderResult(result, { expanded: false }, ansi, ctx), 4000);
		assert.ok(plain.includes("…"), "clipped");
		assert.ok(!plain.includes("metadata:"), "metadata hidden collapsed");
		assert.ok(!plain.includes("detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail detail"), "full body not shown");
	});

	it("expanded shows the full body plus the metadata line", () => {
		const plain = renderPlain(tools.get("team_lookup")!.renderResult(result, { expanded: true }, ansi, ctx), 4000);
		assert.ok(plain.includes("metadata: extra_key=extra_value"));
		assert.ok(plain.length > 400, "full body present");
	});
});
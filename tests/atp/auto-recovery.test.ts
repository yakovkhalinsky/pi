/**
 * C10 — dropout auto-recovery: stream-dropout ("Child subagent finished
 * without an assistant response") detection in subagent/subagent_resume
 * tool_results, session-id extraction, the max-1 auto-recovery budget per
 * child session id, and the narrated-recovery steer the extension queues so
 * the parent issues a *narrated* subagent_resume (never a silent retry).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	createMockCtx,
	createMockPi,
	importExtension,
	loadExtension,
} from "./harness.ts";

const mod = await importExtension();

const CHILD_SESSION = "01234567-89ab-4cde-8f01-23456789abcd";

/** pi-submarine renderSubagentRecoverableError shape for a stream dropout. */
function dropoutErrorText(agent: string, sessionId: string): string {
	return [
		`## Subagent ${agent} error`,
		"",
		"Child subagent finished without an assistant response.",
		"",
		`Subagent session ID: ${sessionId}`,
		"",
		"This child session may be resumable. To continue this exact child session, call `subagent_resume` with this session ID and a message.",
	].join("\n");
}

function dropoutEvent(overrides: any = {}): any {
	return {
		toolName: "subagent",
		isError: true,
		content: [{ type: "text", text: dropoutErrorText("researcher", CHILD_SESSION) }],
		details: null,
		...overrides,
	};
}

describe("C10-1: detectEmptyResponseDropout — marker detection", () => {
	it("detects the stream dropout in an errored subagent result", () => {
		const d = mod.detectEmptyResponseDropout(dropoutEvent());
		assert.ok(d, "dropout should be detected");
		assert.equal(d.sessionId, CHILD_SESSION);
		assert.equal(d.agent, "researcher");
	});

	it("rejects other errors (isError without the marker)", () => {
		const d = mod.detectEmptyResponseDropout(
			dropoutEvent({ content: [{ type: "text", text: `## Subagent researcher error\n\nConnection reset.\n\nSubagent session ID: ${CHILD_SESSION}` }] }),
		);
		assert.equal(d, null);
	});

	it("rejects non-error results even when the marker text appears", () => {
		const d = mod.detectEmptyResponseDropout(dropoutEvent({ isError: false }));
		assert.equal(d, null);
	});

	it("rejects dropout text with no discoverable session id", () => {
		const d = mod.detectEmptyResponseDropout(
			dropoutEvent({ content: [{ type: "text", text: "Child subagent finished without an assistant response." }], details: null }),
		);
		assert.equal(d, null);
	});

	it("falls back to details.run.sessionId when the text omits the id line", () => {
		const text = "## Subagent builder error\n\nChild subagent finished without an assistant response.\n";
		const d = mod.detectEmptyResponseDropout({
			isError: true,
			content: [{ type: "text", text }],
			details: { run: { episodeId: "e1", sessionId: "aaaa1111-2222-4333-8444-555566667777", agent: "builder", status: "failed" } },
		});
		assert.ok(d);
		assert.equal(d.sessionId, "aaaa1111-2222-4333-8444-555566667777");
		assert.equal(d.agent, "builder");
	});

	it("ignores non-subagent tool results via the wiring (toolName filter)", async () => {
		const { pi } = await loadExtension();
		const { ctx } = createMockCtx();
		try {
			await pi.__emit("tool_result", { toolName: "bash", isError: true, content: [{ type: "text", text: dropoutErrorText("x", CHILD_SESSION) }] }, ctx);
			assert.equal(pi.sentUserMessages.length, 0);
		} finally {
			await pi.__emit("session_shutdown");
		}
	});
});

describe("C10-2: extractSessionIdFromErrorText", () => {
	it("parses `Subagent session ID: <uuid>`", () => {
		assert.equal(mod.extractSessionIdFromErrorText(dropoutErrorText("verifier", CHILD_SESSION)), CHILD_SESSION);
	});

	it("returns null when no id line exists", () => {
		assert.equal(mod.extractSessionIdFromErrorText("Child subagent finished without an assistant response."), null);
	});
});

describe("C10-3: budget — one auto-recovery per child session id", () => {
	it("first attempt allowed, second denied", () => {
		const counts = new Map<string, number>();
		assert.equal(mod.shouldAutoRecover(counts, CHILD_SESSION), true);
		counts.set(CHILD_SESSION, (counts.get(CHILD_SESSION) ?? 0) + 1);
		assert.equal(mod.shouldAutoRecover(counts, CHILD_SESSION), false);
	});

	it("MAX_AUTO_RECOVERY_PER_SESSION is 1", () => {
		assert.equal(mod.MAX_AUTO_RECOVERY_PER_SESSION, 1);
	});
});

describe("C10-4: buildRecoverySteerMessage — narration requirement baked in", () => {
	const steer = mod.buildRecoverySteerMessage("researcher", CHILD_SESSION);

	it("names the dead child session", () => {
		assert.ok(steer.includes(CHILD_SESSION));
		assert.ok(steer.includes("Subagent researcher"));
	});

	it("carries the marker and demands visible narration in the same message", () => {
		assert.ok(steer.includes("Child subagent finished without an assistant response."));
		assert.ok(steer.includes("narrate"));
		assert.ok(steer.includes("Never resume silently"));
		assert.ok(steer.includes("subagent_resume"));
	});

	it("states the stop condition (budget of one, no retry)", () => {
		assert.ok(steer.includes("do not retry"));
		assert.ok(steer.includes("one attempt"));
	});
});

describe("C10-5: tool_result wiring — steer on first dropout, escalate on second", () => {
	it("queues ONE narrated-recovery steer (deliverAs steer) + observability entry, then budget exhausts", async () => {
		const { pi } = await loadExtension();
		const { ctx, captured } = createMockCtx();
		try {
			await pi.__emit("tool_result", dropoutEvent(), ctx);
			// first dropout → one steer with the narrated-resume instruction
			assert.equal(pi.sentUserMessages.length, 1);
			assert.equal(pi.sentUserMessages[0].opts?.deliverAs, "steer");
			assert.ok(pi.sentUserMessages[0].content.includes(CHILD_SESSION));
			assert.ok(pi.sentUserMessages[0].content.includes("subagent_resume"));
			assert.equal(pi.appendEntries.filter((e: any) => e.customType === "atp.auto_recovery").length, 1);
			assert.equal(captured.notify.length, 0, "no user escalation while budget remains");

			// second dropout on the SAME child session → no steer, user escalation
			await pi.__emit("tool_result", dropoutEvent(), ctx);
			assert.equal(pi.sentUserMessages.length, 1, "loop guard: no second auto-recovery");
			const exhausted = pi.appendEntries.filter((e: any) => e.customType === "atp.auto_recovery_exhausted");
			assert.equal(exhausted.length, 1);
			assert.equal(captured.notify.length, 1);
			assert.match(captured.notify[0].msg, /budget exhausted/);
			assert.match(captured.notify[0].msg, new RegExp(CHILD_SESSION.slice(0, 8)));
			assert.equal(captured.notify[0].level, "warning");
		} finally {
			await pi.__emit("session_shutdown");
		}
	});

	it("session_shutdown clears the budget (fresh session recovers again)", async () => {
		const { pi } = await loadExtension();
		const { ctx } = createMockCtx();
		await pi.__emit("tool_result", dropoutEvent(), ctx);
		assert.equal(pi.sentUserMessages.length, 1);
		await pi.__emit("session_shutdown");
		const { pi: pi2 } = await loadExtension();
		try {
			await pi2.__emit("tool_result", dropoutEvent(), ctx);
			assert.equal(pi2.sentUserMessages.length, 1, "after shutdown the same session id gets one recovery again");
		} finally {
			await pi2.__emit("session_shutdown");
		}
	});

	it("recovery fires without a UI (headless mode) and skips widget rendering", async () => {
		const { pi } = await loadExtension();
		const { ctx, captured } = createMockCtx({ mode: "headless", hasUI: false });
		try {
			await pi.__emit("tool_result", dropoutEvent(), ctx);
			assert.equal(pi.sentUserMessages.length, 1);
			assert.equal(captured.setWidget["atp"], undefined, "no widget render in headless mode");
		} finally {
			await pi.__emit("session_shutdown");
		}
	});

	it("resume-tool dropouts (subagent_resume) recover through the same path", async () => {
		const { pi } = await loadExtension();
		const { ctx } = createMockCtx();
		try {
			await pi.__emit(
				"tool_result",
				dropoutEvent({ toolName: "subagent_resume", agent: "researcher" }),
				ctx,
			);
			assert.equal(pi.sentUserMessages.length, 1);
		} finally {
			await pi.__emit("session_shutdown");
		}
	});

	it("non-dropout tool_results trigger no steer and no entries", async () => {
		const { pi } = await loadExtension();
		const { ctx } = createMockCtx();
		try {
			await pi.__emit(
				"tool_result",
				dropoutEvent({ content: [{ type: "text", text: `## Subagent researcher error\n\nConnection reset.\n\nSubagent session ID: ${CHILD_SESSION}` }] }),
				ctx,
			);
			await pi.__emit("tool_result", dropoutEvent({ isError: false }), ctx);
			assert.equal(pi.sentUserMessages.length, 0);
			assert.equal(pi.appendEntries.length, 0);
		} finally {
			await pi.__emit("session_shutdown");
		}
	});
});
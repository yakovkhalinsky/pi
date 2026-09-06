/**
 * C9 — command guards: /team-board requires interactive mode; the interactive
 * overlay states the workspace, renders the compact board, and closes on Esc.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	TEST_GOAL,
	createFixtureDb,
	createMockCtx,
	createTheme,
	fixtureRecord,
	loadExtension,
	testEnv,
	withEnv,
} from "./harness.ts";

const ansi = createTheme("ansi");

describe("C9: /team-board command", () => {
	it("outside interactive mode → loud notify, no overlay", async () => {
		const db = createFixtureDb([fixtureRecord({})]);
		try {
			await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath }), async () => {
				const { commands } = await loadExtension();
				const { ctx, captured } = createMockCtx({ mode: "headless", hasUI: false });
				await commands.get("team-board")!.handler("", ctx);
				assert.ok(captured.notify.at(-1).msg.includes("/team-board requires interactive mode"));
				assert.equal(captured.notify.at(-1).level, "error");
				assert.equal(captured.custom.length, 0, "no overlay attempted");
			});
		} finally {
			db.dispose();
		}
	});

	it("closed goals are hidden from the default view; 'all' includes them", async () => {
		const db = createFixtureDb([
			fixtureRecord({ goalId: TEST_GOAL, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", body: '{"title":"Done Goal"}', createdAt: 1_760_000_001 }),
			fixtureRecord({ goalId: TEST_GOAL, recordType: "archival_record", owner: "archivist", status: "completed", createdAt: 1_760_000_002 }),
		]);
		try {
			await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath }), async () => {
				const { commands } = await loadExtension();
				const { ctx, captured, theme } = createMockCtx();
				await commands.get("team-board")!.handler("", ctx);
				assert.equal(captured.custom.length, 1);
				const plain = captured.custom[0].render(100).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, "")).join("\n");
				assert.ok(!plain.includes("Done Goal"), "closed row hidden by default");
				assert.ok(plain.includes("No open goals found"), "empty-board message names the state");
				assert.ok(plain.includes("1 closed goal hidden"), "hidden count stated");
				assert.ok(plain.includes("team-purge"), "removal path advertised");

				await commands.get("team-board")!.handler("all", ctx);
				assert.equal(captured.custom.length, 2);
				const allPlain = captured.custom[1].render(100).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, "")).join("\n");
				assert.ok(allPlain.includes("Done Goal"), "'all' shows the closed row");
			});
		} finally {
			db.dispose();
		}
	});

	it("interactive: overlay renders the compact board + workspace line; Esc closes", async () => {
		const db = createFixtureDb([
			fixtureRecord({ goalId: TEST_GOAL, recordType: "goal_record", stage: "goal_receipt", owner: "dispatcher", body: '{"title":"Board Overlay"}', createdAt: 1_760_000_001 }),
			fixtureRecord({ goalId: TEST_GOAL, recordType: "action_record", stage: "action", owner: "builder", createdAt: 1_760_000_002 }),
		]);
		try {
			await withEnv(testEnv({ EDEN_MEMORY_DB: db.dbPath }), async () => {
				const { commands } = await loadExtension();
				const { ctx, captured, theme } = createMockCtx();
				await commands.get("team-board")!.handler("", ctx);
				assert.equal(captured.custom.length, 1, "overlay opened");
				const overlay = captured.custom[0];
				const plain = overlay.render(80).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, "")).join("\n");
				assert.ok(plain.includes("Goal Board"), "board title");
				assert.ok(plain.includes("workspace: test-ws (env ATP_WORKSPACE_ID)"), "workspace stated (C6-2)");
				assert.ok(plain.includes("Board Overlay"), "goal row");
				assert.ok(plain.includes("Press Esc to close"), "closing hint");
				assert.equal(captured.customDone, false);
				overlay.handleInput("\x1b"); // esc
				assert.equal(captured.customDone, true, "esc closes the overlay");
			});
		} finally {
			db.dispose();
		}
	});
});
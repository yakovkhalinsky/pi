/**
 * T3 — real eden-memory CLI end-to-end (opt-in: ATP_E2E=1). All writes go to
 * scratch DBs under /tmp via EDEN_DB_PATH; identity resolves from the machine
 * config like production does — no identifiers are hardcoded or printed.
 *
 *   B2-5: project-.env hijack e2e — probe, reads, and writes land in the same file
 *   B3-5: cross-workspace isolation with the real CLI
 *   C8-5b: steer consume-once with the real CLI's edit
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createMockCtx, execRun, importExtension, loadExtension, withEnv } from "./harness.ts";

const mod = await importExtension();

const E2E = process.env.ATP_E2E === "1";
const REAL_BIN = process.env.EDEN_MEMORY_BIN || "eden-memory";
const describeE2E = E2E ? describe : describe.skip;

/** Env for e2e: scratch DB via EDEN_DB_PATH (the hijack vector), real CLI, real identity. */
function e2eEnv(dbPath: string, ws: string): Record<string, string | undefined> {
	return {
		EDEN_DB_PATH: dbPath,
		EDEN_MEMORY_DB: undefined, // probe must run
		EDEN_MEMORY_BIN: undefined, // real binary
		EDEN_ORG_ID: undefined, // identity from the machine config, like production
		EDEN_USER_ID: undefined,
		USER_ID: undefined,
		ATP_WORKSPACE_ID: ws,
	};
}

describeE2E("T3 e2e: real eden-memory CLI (ATP_E2E=1)", () => {
	const dirs: string[] = [];
	function scratch(): { dbPath: string; dispose: () => void } {
		const dir = mkdtempSync(join(tmpdir(), "atp-e2e-"));
		dirs.push(dir);
		return { dbPath: join(dir, "e2e.db"), dispose: () => rmSync(dir, { recursive: true, force: true }) };
	}
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("B2-5: under an EDEN_DB_PATH hijack, write and board read land in the same real file", async () => {
		const { dbPath, dispose } = scratch();
		try {
			await withEnv(e2eEnv(dbPath, "atp-e2e-hijack"), async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				// 1) the CLI itself creates the schema in the hijacked file on first write
				const remember = await tools.get("team_remember")!.execute(
					"e2e-b2",
					{ agent_id: "builder", goal_id: "e2222222-2222-4222-8222-222222222222", stage: "action", owner_role: "builder", record_type: "action_record", status: "completed", body: "e2e write" },
					undefined,
					() => {},
					ctx,
				);
				assert.ok(remember.details.recordId, "real CLI accepted the write");
				// 2) the board read hits the same hijacked file (probe pinned --db)
				const status = await tools.get("team_status")!.execute("e2e-b2b", {}, undefined, () => {}, ctx);
				assert.equal(status.details.count, 1, "board read the same scratch file");
				assert.equal(status.details.workspace, "atp-e2e-hijack");
				// 3) the real CLI's health agrees on the effective path
				const health = await execRun(REAL_BIN, ["health"], { timeout: 20000 });
				assert.ok(health.stdout.includes(dbPath), "health reports the hijacked db_path");
			});
		} finally {
			dispose();
		}
	});

	it("B3-5: cross-workspace isolation with the real CLI", async () => {
		const { dbPath, dispose } = scratch();
		try {
			await withEnv(e2eEnv(dbPath, "atp-e2e-a"), async () => {
				const { tools } = await loadExtension();
				const { ctx } = createMockCtx();
				await tools.get("team_remember")!.execute(
					"e2e-b3",
					{ agent_id: "builder", goal_id: "a3333333-3333-4333-8333-333333333333", stage: "action", owner_role: "builder", record_type: "action_record", body: "ws-a record", workspace: "atp-e2e-a" },
					undefined,
					() => {},
					ctx,
				);
				const fromA = await tools.get("team_status")!.execute("e2e-b3a", { workspace: "atp-e2e-a" }, undefined, () => {}, ctx);
				assert.equal(fromA.details.count, 1, "visible from ws-a");
				const fromB = await tools.get("team_status")!.execute("e2e-b3b", { workspace: "atp-e2e-b" }, undefined, () => {}, ctx);
				assert.equal(fromB.details.count, 0, "invisible from ws-b");
			});
		} finally {
			dispose();
		}
	});

	it("C8-5b: steer consume-once against the real CLI's edit", async () => {
		const { dbPath, dispose } = scratch();
		try {
			await withEnv(e2eEnv(dbPath, "atp-e2e-steer"), async () => {
				const { pi, tools } = await loadExtension();
				const { ctx } = createMockCtx();
				await tools.get("team_steer")!.execute("e2e-c8", { role: "builder", message: "real steer" }, undefined, () => {}, ctx);
				const cfg = mod.edenConfig(ctx);
				const first = await mod.consumePendingSteers(pi, ctx, cfg, "builder", undefined);
				assert.equal(first.length, 1);
				assert.ok(first[0].includes("real steer"));
				const second = await mod.consumePendingSteers(pi, ctx, cfg, "builder", undefined);
				assert.equal(second.length, 0, "delivered exactly once");
			});
		} finally {
			dispose();
		}
	});
});
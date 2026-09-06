/**
 * B1 — eden.sh failure contract (bash tier). Each case runs a fresh `bash -c`
 * with a scrubbed environment, a fake HOME (no ~/.eden-memory/.env), the stub
 * CLI binary, and a bash `sleep()` shim so retry tests are instant.
 *
 * Contract under test (F3/F6):
 *   - success stdout is parse-clean (a bare id / JSON), logs on stderr
 *   - empty id → 3 attempts with sleeps 2,5 → loud failure, non-zero exit
 *   - eden_recall/eden_search require agent_id (no silent empties)
 *   - CLI exit 0 with empty stdout → loud failure
 *   - lookup not-found is NOT an error
 *   - sourcing without EDEN_ORG_ID and no TTY fails loudly with the exact fix
 *   - EDEN_ENV_FILE override honored; env wins over file; quotes stripped;
 *     unknown keys skipped; workspace resolution order
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { execFileSync } from "node:child_process";
import { execRun, installFixtureBin, readArgvLog } from "./harness.ts";

const EDEN_SH = fileURLToPath(new URL("../../agent/skills/agentic-team-protocol/eden.sh", import.meta.url));

const UNSETS =
	"unset EDEN_ORG_ID EDEN_USER_ID USER_ID WORKSPACE_ID ATP_WORKSPACE_ID EDEN_MEMORY_DB EDEN_MEMORY_BIN EDEN_ENV_FILE EDEN_FIXTURE_MODE EDEN_FIXTURE_LOG EDEN_FIXTURE_STATE EDEN_FIXTURE_DB_PATH EDEN_FIXTURE_RECALL_JSON EDEN_FIXTURE_LOOKUP_JSON";

function makeCtx() {
	const dir = mkdtempSync(join(tmpdir(), "atp-eden-sh-"));
	const fakeHome = mkdtempSync(join(tmpdir(), "atp-fake-home-"));
	// a hermetic git repo for workspace-resolution tests (basename derived, no absolute personal paths)
	const gitRepo = mkdtempSync(join(tmpdir(), "atp-git-ws-"));
	execFileSync("git", ["init", "-q", gitRepo]);
	const { binPath, logPath, statePath, dispose } = installFixtureBin();
	return {
		dir,
		fakeHome,
		gitRepo,
		gitRepoBase: basename(gitRepo),
		binPath,
		logPath,
		statePath,
		sleepLog: join(dir, "sleep.log"),
		dispose: () => {
			dispose();
			rmSync(dir, { recursive: true, force: true });
			rmSync(fakeHome, { recursive: true, force: true });
			rmSync(gitRepo, { recursive: true, force: true });
		},
	};
}

/** Build and run one isolated bash script against eden.sh. */
function runSh(ctx: ReturnType<typeof makeCtx>, body: string, opts: { mode?: string; envFile?: string; cwd?: string; env?: Record<string, string>; noWs?: boolean } = {}) {
	const exports = [
		opts.noWs ? `export EDEN_ORG_ID=my-org EDEN_USER_ID=my-user` : `export EDEN_ORG_ID=my-org EDEN_USER_ID=my-user ATP_WORKSPACE_ID=test-ws`,
		`export EDEN_MEMORY_BIN="${ctx.binPath}" EDEN_FIXTURE_LOG="${ctx.logPath}"`,
		opts.mode ? `export EDEN_FIXTURE_MODE=${opts.mode}` : "",
		opts.statePath ? `export EDEN_FIXTURE_STATE="${opts.statePath}"` : "",
		opts.envFile ? `export EDEN_ENV_FILE="${opts.envFile}"` : "",
		opts.env ? Object.entries(opts.env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n") : "",
	]
		.filter(Boolean)
		.join("\n");
	const script = [
		UNSETS,
		`export HOME="${ctx.fakeHome}"`,
		`sleep() { printf '%s\\n' "$1" >> "${ctx.sleepLog}"; }`,
		exports,
		`cd "${opts.cwd ?? ctx.fakeHome}"`,
		`source "${EDEN_SH}" >/dev/null 2>&1 || { printf 'SOURCE_FAILED=%s' "$?"; exit 0; }`,
		body,
	].join("\n");
	return execRun("bash", ["-c", script], { cwd: opts.cwd, env: {} });
}

describe("B1: eden.sh failure contract", () => {
	const ctx = makeCtx();
	after(() => ctx.dispose());

	/** Reset shared fixture logs/state so each test observes only its own calls. */
	function fresh() {
		for (const f of [ctx.logPath, ctx.sleepLog, ctx.statePath]) rmSync(f, { force: true });
	}

	it("B1-1: successful eden_remember prints ONLY the id on stdout, nothing on stderr", async () => {
		const res = await runSh(ctx, `id=$(eden_remember builder "Goal: g | Stage: action | Owner: builder
body text" '{}')
printf 'ID=%s' "$id"`, {});
		assert.equal(res.code, 0);
		assert.match(res.stdout, /^ID=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		assert.equal(res.stderr, "", "success path is stderr-clean");
	});

	it("B1-2: transient empty ids retried 3 attempts with sleeps 2 then 5, then success", async () => {
		fresh();
		const res = await runSh(ctx, `id=$(eden_remember builder "body" '{}') && printf 'ID=%s' "$id"`, {
			mode: "fail-twice-then-ok",
			statePath: ctx.statePath,
		});
		assert.equal(res.code, 0);
		assert.match(res.stdout, /^ID=[0-9a-f-]{36}$/);
		assert.equal(readFileSync(ctx.sleepLog, "utf8"), "2\n5\n", "sleep 2 after attempt 1, sleep 5 after attempt 2");
		const rememberCalls = (await readArgvLog(ctx.logPath)).filter((c) => c.argv.includes("remember"));
		assert.equal(rememberCalls.length, 3, "exactly three attempts");
	});

	it("B1-3: persistent empty id → 3 attempts, loud failure on stderr, non-zero exit, clean stdout", async () => {
		fresh();
		const res = await runSh(ctx, `eden_remember builder "body" '{}'; printf 'RC=%s' "$?"`, { mode: "empty-id" });
		assert.equal(res.stdout, "RC=1", "stdout stays parse-clean on failure");
		assert.ok(res.stderr.includes("eden_remember: FAILED"), "loud failure note");
		assert.ok(res.stderr.includes("agent=builder"), "names the agent");
		assert.ok(res.stderr.includes("workspace=test-ws"), "names the workspace");
		assert.equal(readFileSync(ctx.sleepLog, "utf8"), "2\n5\n", "slept between all three attempts");
		const rememberCalls = (await readArgvLog(ctx.logPath)).filter((c) => c.argv.includes("remember"));
		assert.equal(rememberCalls.length, 3);
	});

	it("B1-4: eden_recall/eden_search without agent_id fail loudly BEFORE any CLI call; with agent_id they pass it through", async () => {
		fresh();
		const miss = await runSh(ctx, `eden_recall "find it"; printf 'RC=%s' "$?"`, {});
		assert.equal(miss.stdout, "RC=1");
		assert.ok(miss.stderr.includes("eden_recall: required agent_id argument is missing"));
		assert.ok(miss.stderr.includes("--agent-id"), "names the missing flag");
		assert.ok(miss.stderr.includes("eden_recall \"query\" 10 builder"), "shows the fix");

		const missSearch = await runSh(ctx, `eden_search "kw"; printf 'RC=%s' "$?"`, {});
		assert.equal(missSearch.stdout, "RC=1");
		assert.ok(missSearch.stderr.includes("eden_search: required agent_id argument is missing"));
		assert.equal((await readArgvLog(ctx.logPath)).length, 0, "no CLI invocation on the loud-failure path");

		const hit = await runSh(ctx, `out=$(eden_recall "q" 10 builder) && printf 'OUT=%s' "$out"`, {
			env: { EDEN_FIXTURE_RECALL_JSON: '[{"id":"rec-1"}]' },
		});
		assert.equal(hit.code, 0);
		assert.equal(hit.stdout, 'OUT=[{"id":"rec-1"}]');
		const recallCalls = (await readArgvLog(ctx.logPath)).filter((c) => c.argv.includes("recall"));
		assert.equal(recallCalls.length, 1);
		assert.equal(recallCalls[0].argv[recallCalls[0].argv.indexOf("--agent-id") + 1], "builder", "agent_id forwarded");
	});

	it("B1-5: CLI exit 0 with empty stdout → loud failure, not silent empties", async () => {
		const res = await runSh(ctx, `eden_recall "q" 10 builder; printf 'RC=%s' "$?"`, { mode: "empty-stdout" });
		assert.equal(res.stdout, "RC=1");
		assert.ok(res.stderr.includes("eden-memory returned empty output"), "names the empty-stdout failure");
		assert.ok(res.stderr.includes("agent=builder workspace=test-ws"));
	});

	it("B1-6: lookup not-found is NOT an error (exit 0, found:false passes through)", async () => {
		const res = await runSh(ctx, `out=$(eden_lookup 00000000-0000-0000-0000-000000000000) && printf 'OUT=%s' "$out"`, {});
		assert.equal(res.code, 0);
		assert.ok(res.stdout.includes('"found":false'));
		assert.equal(res.stderr, "");
	});

	it("B1-7: sourcing without EDEN_ORG_ID and no TTY fails loudly with the exact fix", async () => {
		const res = await execRun(
			"bash",
			[
				"-c",
				[UNSETS, `export HOME="${ctx.fakeHome}"`, `source "${EDEN_SH}"`].join("\n"),
			],
			{ env: {} },
		);
		assert.equal(res.code, 1, "sourcing fails the shell");
		assert.ok(res.stderr.includes("EDEN_ORG_ID is not set"), "loud gate message");
		assert.ok(res.stderr.includes("EDEN_ORG_ID=<your-org>"), "exact fix command");
		assert.equal(res.stdout, "", "nothing on stdout");
	});

	it("B1-8: EDEN_ENV_FILE override honored, env wins over file, quotes stripped, unknown keys skipped", async () => {
		const envFile = join(ctx.dir, "test.env");
		writeFileSync(
			envFile,
			[
				"# comment line",
				"UNKNOWN_KEY=skip-me",
				'EDEN_ORG_ID="my-org"',
				"EDEN_USER_ID='my-user'",
				"",
			].join("\n"),
		);
		// env preset wins over the file
		const envWins = await runSh(ctx, `printf 'ORG=%s USER=%s' "$EDEN_ORG_ID" "$EDEN_USER_ID"`, {
			envFile,
			env: { EDEN_ORG_ID: "env-org" },
		});
		assert.equal(envWins.stdout, "ORG=env-org USER=my-user", "preset env beats file values");

		// file values used when env unset; quotes stripped; unknown key not exported;
		// no ATP_WORKSPACE_ID preset → workspace falls back to the cwd basename
		const fromFile = await runSh(
			ctx,
			`unset EDEN_ORG_ID EDEN_USER_ID
source "${EDEN_SH}" >/dev/null 2>&1
printf 'ORG=%s USER=%s FOO=%s WS=%s' "$EDEN_ORG_ID" "$EDEN_USER_ID" "$\{UNKNOWN_KEY:-unset\}" "$WORKSPACE_ID"`,
			{ envFile, noWs: true },
		);
		assert.ok(
			fromFile.stdout.includes("ORG=my-org USER=my-user FOO=unset"),
			"quoted file values imported, unknown keys skipped",
		);
		assert.ok(fromFile.stdout.includes(`WS=${basename(ctx.fakeHome)}`), "workspace falls back to cwd basename");
	});

	it("B1-8b: workspace resolution — ATP_WORKSPACE_ID wins over the git toplevel", async () => {
		const res = await runSh(ctx, `printf 'WS=%s' "$WORKSPACE_ID"`, { cwd: ctx.gitRepo });
		assert.equal(res.stdout, "WS=test-ws", "preset ATP_WORKSPACE_ID beats the git toplevel");
	});

	it("B1-8c: workspace falls back to the git toplevel basename when no env preset", async () => {
		const res = await runSh(
			ctx,
			`${UNSETS}
export EDEN_ORG_ID=my-org EDEN_USER_ID=my-user
source "${EDEN_SH}" >/dev/null 2>&1
printf 'WS=%s GITBASE=%s' "$WORKSPACE_ID" "$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")"`,
			{ cwd: ctx.gitRepo },
		);
		assert.ok(res.stdout.includes(`GITBASE=${ctx.gitRepoBase}`));
		const ws = res.stdout.match(/WS=([^ ]*) GITBASE=/)?.[1];
		assert.equal(ws, ctx.gitRepoBase, "WORKSPACE_ID = git toplevel basename");
	});
});
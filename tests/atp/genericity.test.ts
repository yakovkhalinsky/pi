/**
 * B5-3 + B6-1 — wrapper-level forget safety and genericity source scan (T1).
 * Static assertions over the two code files (repo mirrors, byte-identical to
 * the live files): eden.sh must expose no forget/delete surface, and neither
 * file may hardcode org/user identity values — identity is config-driven.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const EDEN_SH = fileURLToPath(new URL("../../agent/skills/agentic-team-protocol/eden.sh", import.meta.url));
const INDEX_TS = fileURLToPath(new URL("../../agent/extensions/agentic-team-protocol/index.ts", import.meta.url));

const edenSh = readFileSync(EDEN_SH, "utf8");
const indexTs = readFileSync(INDEX_TS, "utf8");

describe("B5-3: eden.sh exposes no forget/delete surface", () => {
	it("the wrapper function set is exactly the documented six (+ private import helper)", () => {
		const WRAPPER_FNS = ["eden_setup", "eden_remember", "eden_recall", "eden_search", "eden_lookup", "eden_health"];
		const defined = [...edenSh.matchAll(/^(eden_[a-z_]+)\(\)/gm)].map((m) => m[1]);
		assert.deepEqual(defined.sort(), [...WRAPPER_FNS].sort());
		const privateFns = [...edenSh.matchAll(/^(_[a-z_]+)\(\)/gm)].map((m) => m[1]);
		assert.deepEqual(privateFns.sort(), ["_eden_env_import"]);
	});

	it("no forget/vacuum/delete command is invoked anywhere in the wrapper", () => {
		// strip comments, then look for destructive CLI subcommand invocations
		const code = edenSh
			.split("\n")
			.map((l) => l.replace(/#.*/, ""))
			.join("\n");
		assert.ok(!/\beden-memory\s+(forget|vacuum|prune|migrate)\b/.test(code), "no destructive subcommand call");
		assert.ok(!/\bforget\b/.test(code), "no forget anywhere in executable wrapper code");
	});
});

describe("B6-1: no hardcoded org/user identity in the code files", () => {
	const FORBIDDEN = [
		// literal identity assignments in shell (env/config reads are the only source)
		/EDEN_ORG_ID\s*=\s*["'][A-Za-z0-9][^"']*["']/,
		/EDEN_USER_ID\s*=\s*["'][A-Za-z0-9][^"']*["']/,
		// documented placeholder values must not leak into code as defaults
		/["'](my-org|your-org|<your-org>|<your-user>)["']/,
		// UUID-shaped literals bound to identity fields in TS
		/(orgId|userId|org_id|user_id)\s*[:=]\s*["'][0-9a-f]{8}-[0-9a-f]{4}/i,
	];

	it("eden.sh and index.ts contain no identity literals", () => {
		for (const pattern of FORBIDDEN) {
			assert.ok(!pattern.test(edenSh), `eden.sh matches forbidden pattern ${pattern}`);
			assert.ok(!pattern.test(indexTs), `index.ts matches forbidden pattern ${pattern}`);
		}
	});

	it("positive control: identity resolution is config-driven in both files", () => {
		// eden.sh resolves from env > ~/.eden-memory/.env with no hardcoded fallback
		assert.ok(edenSh.includes('_eden_env_import "$EDEN_ENV_FILE"'), "config-file import present");
		assert.ok(edenSh.includes(': "${EDEN_MEMORY_BIN:='), "env-first resolution present");
		// index.ts reads env, then the config file — never literals
		assert.ok(indexTs.includes('readEnvFileValue("EDEN_ORG_ID")'), "org id read from config file fallback");
		assert.ok(indexTs.includes("process.env.EDEN_ORG_ID"), "org id read from env first");
		assert.ok(indexTs.includes("GENERIC BY DESIGN"), "genericity note present");
	});
});
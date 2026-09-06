#!/usr/bin/env node
// Stub eden-memory CLI for ATP tests (tests/TEST-SCOPE.md §1, T2 tier).
//
// Behavior is env-driven so a single binary serves many scenarios; every
// invocation is appended (one JSON line) to $EDEN_FIXTURE_LOG when set, so
// tests can assert exact argv (db pinning, workspace scoping, org scoping).
//
//   EDEN_FIXTURE_MODE      ok (default) | empty-id | fail-twice-then-ok | busy
//   EDEN_FIXTURE_DB_PATH   db_path reported by `health`
//   EDEN_FIXTURE_STATE     counter file for fail-twice-then-ok
//   EDEN_FIXTURE_LOG       argv log (JSON lines)
//   EDEN_FIXTURE_LOOKUP_JSON  canned lookup reply (default {"found":false})
//   EDEN_FIXTURE_RECALL_JSON  canned recall/search reply (default [])
//
// stdout is always a single JSON line, mirroring the real CLI's parseable
// contract; errors go to stderr with a non-zero exit (mode=busy).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
if (process.env.EDEN_FIXTURE_LOG) {
	try {
		appendFileSync(process.env.EDEN_FIXTURE_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\n");
	} catch {
		/* logging must never break the stub */
	}
}

// The extension pins --db before the subcommand: ["--db", path, "remember", ...]
const sub = (() => {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--db") {
			i++; // skip flag and its value
			continue;
		}
		if (!argv[i].startsWith("--")) return argv[i];
	}
	return "";
})();

const mode = process.env.EDEN_FIXTURE_MODE ?? "ok";
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// Any command exits 0 with truly empty stdout — the audited "silent CLI" case.
if (mode === "empty-stdout") process.exit(0);

switch (sub) {
	case "health":
		emit({ ok: true, db_path: process.env.EDEN_FIXTURE_DB_PATH ?? "/tmp/fixture.db", billable_total: 0 });
		break;
	case "remember": {
		if (mode === "busy") {
			process.stderr.write("SQLITE_BUSY: database is locked\n");
			process.exit(1);
		}
		if (mode === "empty-id") {
			// The audited silent-write failure: exit 0, status remembered, no id.
			emit({ status: "remembered" });
			break;
		}
		if (mode === "fail-twice-then-ok") {
			const sp = process.env.EDEN_FIXTURE_STATE ?? "/tmp/atp-fixture-state";
			let n = 0;
			try {
				n = parseInt(readFileSync(sp, "utf8").trim() || "0", 10) || 0;
			} catch {
				/* first attempt */
			}
			n += 1;
			writeFileSync(sp, String(n));
			if (n < 3) {
				emit({ status: "remembered" }); // transient failure: no id
				break;
			}
		}
		emit({ id: randomUUID(), status: "remembered" });
		break;
	}
	case "edit": {
		// Optionally apply the edit to the real DB (node:sqlite) so downstream
		// reads observe it — this makes steer consume-once provable at T2.
		if (process.env.EDEN_FIXTURE_APPLY === "1") {
			try {
				const { DatabaseSync } = await import("node:sqlite");
				const flag = (name) => {
					const i = argv.indexOf(name);
					return i === -1 ? undefined : argv[i + 1];
				};
				const dbPath = flag("--db");
				const rowId = flag("--id");
				const meta = flag("--metadata");
				if (dbPath && rowId && meta) {
					const db = new DatabaseSync(dbPath);
					db.prepare("UPDATE memories SET metadata = ? WHERE id = ?").run(meta, rowId);
					db.close();
				}
			} catch {
				/* best effort — the ok reply below still goes out */
			}
		}
		emit({ ok: true });
		break;
	}
	case "lookup": {
		let out = { found: false };
		try {
			if (process.env.EDEN_FIXTURE_LOOKUP_DB) {
				// Read the real row from the fixture DB by --id — per-id verification
				// (team_purge) is then exercised against actual row content/metadata.
				const { DatabaseSync } = await import("node:sqlite");
				const flag = (name) => {
					const i = argv.indexOf(name);
					return i === -1 ? undefined : argv[i + 1];
				};
				const dbPath = flag("--db");
				const rowId = flag("--id");
				if (dbPath && rowId) {
					const db = new DatabaseSync(dbPath);
					const row = db.prepare("SELECT id, content, metadata FROM memories WHERE id = ?").get(rowId);
					db.close();
					if (row) out = { found: true, id: row.id, content: row.content, metadata: JSON.parse(row.metadata || "{}") };
				}
			} else if (process.env.EDEN_FIXTURE_LOOKUP_JSON) {
				out = JSON.parse(process.env.EDEN_FIXTURE_LOOKUP_JSON);
			}
		} catch {
			/* fall back to found:false */
		}
		emit(out);
		break;
	}
	case "recall":
	case "search":
	case "search-semantic": {
		let out = [];
		try {
			if (process.env.EDEN_FIXTURE_RECALL_JSON) out = JSON.parse(process.env.EDEN_FIXTURE_RECALL_JSON);
		} catch {
			/* fall back to empty list */
		}
		emit(out);
		break;
	}
	case "forget":
		emit({ forgotten: true });
		break;
	default:
		emit({ ok: true, sub });
}
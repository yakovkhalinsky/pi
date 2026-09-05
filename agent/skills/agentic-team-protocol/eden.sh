#!/usr/bin/env bash
# Eden-memory CLI helper for the Agentic Team Protocol on pi.
#
# pi has no built-in MCP, so ATP talks to Eden-memory through this CLI.
# Source this file from any ATP agent or slash-command bash invocation:
#
#   source "$HOME/.pi/agent/skills/agentic-team-protocol/eden.sh"
#
# It exports identity defaults and defines thin wrappers.
#
# Failure contract (tooling-hardening F3/F6, 2026-09-04):
#   - On success, stdout carries ONLY the parseable result; CLI logs stay on
#     stderr (the wrappers no longer discard stderr — a swallowed CLI error
#     used to look like an empty result).
#   - eden_remember retries up to 3 attempts (sleep 2, then 5, between them).
#     If no record id comes back after the retries, it prints a failure note
#     plus the CLI's stderr to stderr and exits non-zero — never a silent
#     empty id. stdout stays parse-clean (a bare id) on success.
#   - eden_recall / eden_search fail loudly when the required agent_id
#     argument is missing: non-zero exit + a stderr message naming the
#     missing --agent-id flag (no silent empty results). When the CLI itself
#     errors or returns an empty stdout with exit 0, the wrapper prints a
#     note to stderr and exits non-zero.
#   - eden_lookup surfaces CLI errors the same way (a not-found record is
#     NOT an error: the CLI exits 0 with "found": false).
#
# Workspace (F2): a pre-set WORKSPACE_ID wins (explicit by the caller), then
# ATP_WORKSPACE_ID (goal env), then the git-toplevel/cwd default.
#
# Identity is config-driven, not hardcoded: EDEN_ORG_ID / EDEN_USER_ID (and
# optionally EDEN_MEMORY_BIN / EDEN_MEMORY_DB) resolve from the environment
# first, then from the per-machine config file ~/.eden-memory/.env. This file
# ships generic — keep real org/user ids out of the source tree.

# ---------------------------------------------------------------------------
# Identity config — GENERIC BY DESIGN: no org/user ids are hardcoded here.
# Resolution per key: pre-set environment variable > ~/.eden-memory/.env
# (override EDEN_ENV_FILE to point at a different config file).
# ---------------------------------------------------------------------------
EDEN_ENV_FILE="${EDEN_ENV_FILE:-$HOME/.eden-memory/.env}"

# Import known EDEN_* keys from the config file without clobbering the
# environment (env vars win, matching the extension's config resolution).
# Only simple KEY=value lines (optionally quoted) are understood; comments,
# blanks, and unknown keys are skipped.
_eden_env_import() {
	local file="$1" line key value
	[ -f "$file" ] || return 0
	while IFS= read -r line || [ -n "$line" ]; do
		line="${line#"${line%%[![:space:]]*}"}" # ltrim whitespace
		case "$line" in "" | \#*) continue ;; esac
		case "$line" in
			EDEN_ORG_ID=* | EDEN_USER_ID=* | EDEN_MEMORY_BIN=* | EDEN_MEMORY_DB=* | USER_ID=*) ;;
			*) continue ;;
		esac
		key="${line%%=*}" value="${line#*=}"
		value="${value%\"}" value="${value#\"}" # strip one pair of double quotes
		value="${value%\'}" value="${value#\'}" # strip one pair of single quotes
		if [ -z "${!key:-}" ]; then
			export "$key=$value"
		fi
	done < "$file"
}
_eden_env_import "$EDEN_ENV_FILE"

: "${EDEN_MEMORY_BIN:=$(command -v eden-memory || echo "$HOME/.local/bin/eden-memory")}"
: "${USER_ID:=${EDEN_USER_ID:-${USER:-$(id -un)}}}"
: "${WORKSPACE_ID:=${ATP_WORKSPACE_ID:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")}}"

# ---------------------------------------------------------------------------
# Setup — ALWAYS check for config that isn't set and get the user to set it.
#
# eden_setup is idempotent: it only prompts for identity values that are
# still unset, persists them to the config file (mode 600), and exports them
# for the current shell. Values already present in the environment or the
# config file are never asked for or overwritten.
# ---------------------------------------------------------------------------
eden_setup() {
	local file="$EDEN_ENV_FILE" val default_user

	default_user="${USER:-$(id -un)}"

	# Prompting needs a terminal. From agent bash blocks (no TTY) explain the
	# direct fix instead of hanging on a read that can never be answered.
	if [ ! -t 0 ]; then
		printf 'eden_setup: no terminal attached — cannot prompt for missing config. Set it directly:\n' >&2
		printf '  echo "EDEN_ORG_ID=<your-org>" >> %s\n' "$file" >&2
		printf '  echo "EDEN_USER_ID=<your-user>" >> %s   # optional\n' "$file" >&2
		return 1
	fi

	mkdir -p "$(dirname "$file")"
	[ -f "$file" ] || (umask 077 && : > "$file")
	chmod 600 "$file" 2>/dev/null

	_eden_env_import "$file" # re-resolve in case the file changed since source

	# REQUIRED: org id — every eden-memory call and every ATP record is
	# org-scoped by it. Loop until a non-empty value is given (Ctrl-D aborts).
	if [ -z "${EDEN_ORG_ID:-}" ]; then
		printf 'EDEN_ORG_ID is not set — every eden-memory call (and every ATP record) is scoped by it.\n' >&2
		while :; do
			printf '  org id (e.g. my-org): ' >&2
			IFS= read -r val || { printf '\neden_setup: aborted — EDEN_ORG_ID still unset\n' >&2; return 1; }
			[ -n "$val" ] && break
			printf '  an org id is required; it cannot be empty\n' >&2
		done
		printf 'EDEN_ORG_ID=%s\n' "$val" >> "$file"
		export EDEN_ORG_ID="$val"
		printf '  wrote EDEN_ORG_ID → %s\n' "$file" >&2
	fi

	# RECOMMENDED: user id — has a sane fallback ($USER / id -un), so an empty
	# answer just accepts the default without writing anything.
	if [ -z "${EDEN_USER_ID:-}" ]; then
		printf 'EDEN_USER_ID is not set (memory user id; falls back to %s).\n' "$default_user" >&2
		printf '  user id [%s — Enter accepts the fallback]: ' "$default_user" >&2
		IFS= read -r val || val=""
		if [ -n "$val" ]; then
			printf 'EDEN_USER_ID=%s\n' "$val" >> "$file"
			export EDEN_USER_ID="$val"
			USER_ID="$val"
			printf '  wrote EDEN_USER_ID → %s\n' "$file" >&2
		fi
	fi

	# Optional keys with automatic fallbacks — report, don't prompt.
	[ -n "${EDEN_MEMORY_BIN:-}" ] ||
		printf '  note: EDEN_MEMORY_BIN unset — falling back to PATH lookup or %s\n' "$HOME/.local/bin/eden-memory" >&2

	if [ -z "${EDEN_ORG_ID:-}" ]; then
		printf 'eden_setup: EDEN_ORG_ID is still unset — cannot continue\n' >&2
		return 1
	fi
	return 0
}

# Always-check gate: every source re-validates required config. An
# interactive terminal is walked through setup; agent bash blocks (no TTY)
# fail loudly with the exact fix so the user is asked to set it up — never a
# silent write into an empty org.
if [ -z "${EDEN_ORG_ID:-}" ] && [ -t 0 ]; then
	eden_setup || true # fall through to the loud gate below if still unset
fi

if [ -z "${EDEN_ORG_ID:-}" ]; then
	printf 'eden.sh: EDEN_ORG_ID is not set — every eden-memory call is org-scoped and no default is hardcoded.\n' >&2
	printf '  Fix now (one command):  echo "EDEN_ORG_ID=<your-org>" >> %s\n' "$EDEN_ENV_FILE" >&2
	printf '  Or ask the user to re-source this file in an interactive terminal to be walked through setup.\n' >&2
	return 1 2>/dev/null || exit 1
fi

export EDEN_MEMORY_BIN USER_ID EDEN_ORG_ID WORKSPACE_ID

# Remember a record. Prints the new record id (UUID) on stdout.
#   eden_remember <agent_id> <content> <metadata_json>
# The CLI assigns its own id; the returned id is canonical — never pre-generate one
# with uuidgen. If <content> embeds a placeholder 'Record ID:', align it afterwards:
#   "$EDEN_MEMORY_BIN" edit --id <assigned_id> --user-id "$USER_ID" --org-id "$EDEN_ORG_ID" \
#     --workspace-id "$WORKSPACE_ID" --content <content carrying the assigned id> --metadata <same metadata>
#
# F3: retries up to 3 attempts (sleep 2, then 5, between attempts) to ride out
# transient failures (SQLITE_BUSY, embedding errors). Failure detection is an
# empty record id (the CLI can exit 0 while the embedding step failed). The
# CLI's stderr is never suppressed: logs stream to stderr live, and on a
# failed write a loud note + the last CLI stderr are printed before exit 1.
eden_remember() {
	local agent_id="$1" content="$2" metadata="$3"
	[ -z "$metadata" ] && metadata="{}"
	local attempt out id
	for attempt in 1 2 3; do
		# NOTE: no stderr redirection — CLI logs/errors stream live to stderr,
		# so $out only ever holds stdout (the JSON reply) and stays parse-clean.
		out="$("$EDEN_MEMORY_BIN" remember \
			--agent-id "$agent_id" \
			--user-id "$USER_ID" \
			--org-id "$EDEN_ORG_ID" \
			--workspace-id "$WORKSPACE_ID" \
			--content "$content" \
			--metadata "$metadata")"
		id="$(printf '%s\n' "$out" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
		if [ -n "$id" ]; then
			printf '%s\n' "$id"
			return 0
		fi
		if [ "$attempt" -lt 3 ]; then
			if [ "$attempt" -eq 1 ]; then sleep 2; else sleep 5; fi
		fi
	done
	printf 'eden_remember: FAILED — no record id after %s attempts (agent=%s workspace=%s); last eden-memory stderr is printed above\n' \
		"$attempt" "$agent_id" "$WORKSPACE_ID" >&2
	return 1
}

# Recall by semantic query. Prints JSON results (with content) on stdout.
#   eden_recall <query> [limit] [agent_id]
# F6: agent_id is REQUIRED (the CLI needs --agent-id). Omitting it fails
# loudly with a message naming the flag instead of returning silent empties.
eden_recall() {
	local query="$1" limit="${2:-10}" agent_id="${3:-}"
	if [ -z "$agent_id" ]; then
		printf 'eden_recall: required agent_id argument is missing (3rd arg) — eden-memory recall needs --agent-id; pass the role name, e.g. eden_recall "query" 10 builder\n' >&2
		return 1
	fi
	local out rc
	out="$("$EDEN_MEMORY_BIN" recall \
		--user-id "$USER_ID" \
		--org-id "$EDEN_ORG_ID" \
		--workspace-id "$WORKSPACE_ID" \
		--agent-id "$agent_id" \
		--query "$query" \
		--limit "$limit" \
		--include-content)"
	rc=$?
	if [ "$rc" -ne 0 ]; then
		printf 'eden_recall: eden-memory recall failed (exit %s, agent=%s workspace=%s); see CLI stderr above\n' "$rc" "$agent_id" "$WORKSPACE_ID" >&2
		return 1
	fi
	if [ -z "$out" ]; then
		printf 'eden_recall: eden-memory returned empty output (exit 0, agent=%s workspace=%s) — not parseable results\n' "$agent_id" "$WORKSPACE_ID" >&2
		return 1
	fi
	printf '%s\n' "$out"
}

# Keyword search. Prints JSON results (with content) on stdout.
#   eden_search <keywords> [limit] [agent_id]
# F6: agent_id is REQUIRED (the CLI needs --agent-id). Omitting it fails
# loudly with a message naming the missing flag (no silent empty results).
eden_search() {
	local keywords="$1" limit="${2:-50}" agent_id="${3:-}"
	if [ -z "$agent_id" ]; then
		printf 'eden_search: required agent_id argument is missing (3rd arg) — eden-memory search needs --agent-id; pass the role name, e.g. eden_search "keywords" 50 builder\n' >&2
		return 1
	fi
	local out rc
	out="$("$EDEN_MEMORY_BIN" search \
		--user-id "$USER_ID" \
		--org-id "$EDEN_ORG_ID" \
		--workspace-id "$WORKSPACE_ID" \
		--agent-id "$agent_id" \
		--keywords "$keywords" \
		--limit "$limit" \
		--include-content)"
	rc=$?
	if [ "$rc" -ne 0 ]; then
		printf 'eden_search: eden-memory search failed (exit %s, agent=%s workspace=%s); see CLI stderr above\n' "$rc" "$agent_id" "$WORKSPACE_ID" >&2
		return 1
	fi
	if [ -z "$out" ]; then
		printf 'eden_search: eden-memory returned empty output (exit 0, agent=%s workspace=%s) — not parseable results\n' "$agent_id" "$WORKSPACE_ID" >&2
		return 1
	fi
	printf '%s\n' "$out"
}

# Exact record lookup by id. Prints JSON on stdout.
#   eden_lookup <record_id>
# A missing record is NOT an error (CLI exits 0 with "found": false). Only a
# failing CLI (non-zero exit) fails loudly here (F3 loud-failure treatment).
eden_lookup() {
	local out rc
	out="$("$EDEN_MEMORY_BIN" lookup \
		--user-id "$USER_ID" \
		--org-id "$EDEN_ORG_ID" \
		--workspace-id "$WORKSPACE_ID" \
		--id "$1" --include-content)"
	rc=$?
	if [ "$rc" -ne 0 ]; then
		printf 'eden_lookup: eden-memory lookup failed (exit %s, id=%s); see CLI stderr above\n' "$rc" "$1" >&2
		return 1
	fi
	printf '%s\n' "$out"
}

# Health check. Prints JSON on stdout.
eden_health() {
	"$EDEN_MEMORY_BIN" health --user-id "$USER_ID" --org-id "$EDEN_ORG_ID" 2>/dev/null
}
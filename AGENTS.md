# Agent instructions — PUBLIC repo

This repository is **public**: every commit is world-visible and effectively
permanent. Treat "it might be private" as "it is public". History reshaping
(force-push) is exceptional — never as a cleanup for leaked secrets.

## Never commit

Secrets and private state, even if `.gitignore` would catch them — verify
what is staged before every commit (`git status`, `git diff --cached`):

- `agent/auth.json`, `agent/models.json`, `agent/models-store.json` (credentials)
- `agent/sessions/` (conversation transcripts)
- `agent/pi-pretty/`, `agent/npm/node_modules/`, `agent/npm/package-lock.json`, `node/` (caches, regenerated)
- Any `.env` or similarly named file
- Real API keys anywhere — `agent/models.example.json` must keep `"apiKey": ""`
- eden-memory org/user identifiers with real values — use the documented
  placeholders (`EDEN_ORG_ID=<your-org>`, `EDEN_ORG_ID=my-org`) only
- Absolute personal paths (`/Users/<name>/`, `/home/<name>/`) — use `~/` or
  `$HOME`; terminal-output captures containing them are also out of bounds

Personal-but-public facts are fine: the public GitHub handle
(`yakovkhalinsky`) and `yakov.khalinsky.com` links.

## Guardrails

- `scripts/check-public-safe.sh` scans staged changes; run it before every
  commit. It runs on every push in CI (`.github/workflows/public-safe.yml`)
  and as the pre-commit hook (`git config core.hooksPath .githooks`).
- If the check fails: **stop and surface the finding to the user**. Never
  weaken the script's patterns or delete its findings to make a commit go
  through.
- When refreshing this backup from `~/.pi/`, copy only the paths listed in
  README's "Updating this backup" section, and re-run the check before
  committing.

## Docs stay in sync

Any change that alters documented behavior must update the docs in the
**same commit** — README.md is the contract:

- `install.sh` (versions, steps, PATH handling, new sections) → README's
  "What `install.sh` does" steps AND install.sh's own header/source-layout
  comments.
- `agent/npm/package.json` or `agent/settings.json` (pins, overrides,
  allowScripts, package list) → README's "What's backed up" table and the
  relevant install steps.
- Version bumps touch three places together: `PI_VERSION` in install.sh,
  `agent/npm/package.json`, and the pinned specs in `agent/settings.json`
  — plus the README steps that name the versions.
- New files in the repo → README's "What's backed up" table and install.sh's
  source-layout comment.
- If a docs claim and the code disagree, fix both or fix one — never leave
  them diverging.
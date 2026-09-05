# Global Agentic Team Protocol Charter

This is the **default global charter** used when a project does not define its
own `agentic-team-charter.md`. It is safe to ratify as a starting point and
can be overridden by a project-local charter in `.pi/agentic-team-charter.md` (or `.cursor/agentic-team-charter.md` / `.claude/agentic-team-charter.md` if that is all the project has).

## Scope

This charter governs agentic teams using the Agentic Team Protocol with
eden-memory as the durable memory substrate.

## Roles

The default active roles are:

| Role | Purpose |
|------|---------|
| Dispatcher | Decides what to build and delegates goals to the right role. |
| Researcher | Investigates, evaluates, and reports options. |
| Builder | Implements and tests the chosen approach. |
| Verifier | Reviews outputs for correctness, safety, and charter compliance. |
| Archivist | Records goal lifecycle data and manages memory hygiene. |

Runtime is **not active by default** and requires explicit project-local charter
authorisation before it may operate on anything beyond local development tools.
When a project charter authorises Runtime, routine commit/push of verified changes
to that project's repository is within its normal scope and does not require
per-action user approval.

## Decision rights

- **Task ownership**: Dispatcher assigns; owning role decides implementation
details within its scope.
- **Tooling / dependencies**: Researcher recommends; Builder decides; Verifier
vetos risky choices.
- **Deploy timing**: Verifier must approve; Runtime executes only if authorised.
- **Verification verdict**: Verifier owns final green/red judgement.
- **Charter changes**: require re-ratification by the project owner or Founders'
Circle.

## Escalation path

1. Owning role → Dispatcher/Overseer within one status period.
2. Dispatcher → Anchor Operations Chair same day.
3. Chair → Founders' Circle within 48 hours for guardrail / risk issues.
4. Final call by Founders' Circle or project owner.

## Guardrails

- Secrets must never be stored in eden-memory.
- Runtime may not touch production systems without explicit charter authorisation.
- Every goal must end in either a hand-off/closure record or an escalation record.
- Charter changes require re-ratification.
- Non-trivial changes require a feature branch; direct commits to the default branch are allowed only for trivial one-line fixes.
- Merges into the default branch must be non-fast-forward merge commits that preserve both parent SHAs.
- Force-pushing the default branch is prohibited.
- Durable records must embed their `goal_id` and own `record_id` in searchable `content` (e.g., `Goal: <goal_id> | Record ID: <this_record_id> | Stage: <stage> | Owner: <owner_role>`) so `eden_recall` and `eden_search` can locate them by UUID; metadata alone is not searchable.

## Branch discipline

Projects that ratify this charter must keep the default branch (commonly `main`
or `master`) protected by the following rules, unless a project-local charter
explicitly overrides them:

1. **Feature branches for non-trivial work.** Any change that touches more than
   one file, alters behaviour, or is dispatched as a `build` or `run` package
   must be developed on a feature branch.
2. **Trivial fixes only on the default branch.** Single-line corrections (for
   example, typo fixes or single flag default changes) may be committed directly to
   the default branch.
3. **Non-fast-forward merge commits.** Merges into the default branch must
   create a merge commit with a descriptive conventional-commit message.
4. **Record both parent SHAs.** Runtime records the feature-branch SHA and the
   previous default-branch SHA in the merge action record.
5. **No force-push.** Force-pushing the default branch is never permitted.
6. **Runtime authority.** Runtime is the only role that may create merge commits
   and push to the default branch, and only after a green Verifier verdict.
7. **Feature-branch cleanup.** After a clean non-fast-forward merge into the
   default branch, Runtime deletes the local feature branch with
   `git branch -d <branch>`. If the branch exists on origin, is not protected or
   long-lived, and is not shared by other work, Runtime also deletes the remote
   branch with `git push origin --delete <branch>`. Skip cleanup when there is no
   remote, the branch is protected or long-lived, the branch has unmerged
   commits, or the environment is headless and cannot safely delete the checked-out
   branch; record the reason in the action record.

## Ratification

This charter is ratified when `/team-charter` records a
`charter_ratification` entry in eden-memory. The first ratification may be done
by the project owner. Fleet-wide charters require Founders' Circle sign-off.

## Version and amendments

- Version is the short SHA-256 hash of the charter content.
- Amendments: propose → review → re-ratify → archive previous version.
- Archivist owns the amendment log.

## Retirement

A team retires by:
1. Archiving the ratification record.
2. Marking eden-memory team records as `team_retired`.
3. Removing local agent/command files only after archival is verified.

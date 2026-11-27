# Implement handoff

The contract between implement and the stages either side of it (PLAN.md section 5). A manual handoff leaves the same state as the package, so review (slice 4) and merge work the same either way.

## Entry

`scaffold:plan-approved` on the issue, and a developer assigns the issue to Copilot (or implements it by hand). The PR links the issue with a closing keyword ("Fixes #<issue>").

## Checks upstream

- **Plan:** `scaffold-plan-gate` re-checks the issue timeline: the latest `scaffold:plan-approved` was applied by a listed approver who isn't the issue author, wasn't removed since, and (with plan on) came after the plan comment's last edit. With plan off, only that a listed approver applied the label.
- **Scenarios:** when the issue needs them, they must still be approved (same check as plan's, with intake on or off).

## Exit

A PR linked to the issue that:

- passes `scaffold-plan-gate`;
- is within the soft size limit (`pr_size.soft`, exempt files not counted), or has `scaffold:size-exception` applied by a listed approver who isn't the PR author, after a `/size-exception <reason>` comment;
- passes the core baseline checks (protected paths, hard size limit, test integrity, scenarios), which run whatever `stages` says;
- passes `scaffold-review-gate`: it waits for every other check on the head commit, then requests review from the developers assigned to the issue. On a Copilot PR with failing checks it posts one `@copilot` rework comment per commit listing them; after `max_rework_rounds` rounds it applies `scaffold:escalate` and hands the PR to human review (the circuit breaker).

The PR has one SCAFFOLD status comment: plan gate, size, review gate, rework rounds and work in progress (advisory: open Copilot PRs per assigned developer over `warn_open_prs_per_developer`).

Copilot's own skills (`tdd`, `implement`) are in `copilot-skills/`; a repo admin copies them to `.github/skills/` (see `copilot-skills/README.md`).

## When implement is off

`stages.implement` is `false` or missing in `.github/scaffold-config.yml`. `scaffold-plan-gate`, `scaffold-pr-size` and `scaffold-review-gate` pass as "stage off: manual"; nothing asks Copilot for rework. Humans:

1. Only start work on an issue with `scaffold:plan-approved` applied by a listed approver.
2. Link the PR to the issue ("Fixes #<issue>").
3. Keep the PR within `pr_size.soft` (exempt files not counted). Over it, split the work, or get a listed approver to agree an exception and record the reason on the PR.
4. Request review when every check passes. If Copilot's PR keeps failing, prompt it with the failures; after `max_rework_rounds` attempts, apply `scaffold:escalate` and review it by hand.

The hard size limit and the other baseline checks still apply.

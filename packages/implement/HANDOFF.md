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
- is ready for human review.

The PR has one SCAFFOLD status comment with its gates.

## When implement is off

`stages.implement` is `false` or missing in `.github/scaffold-config.yml`. `scaffold-plan-gate` and `scaffold-pr-size` pass as "stage off: manual"; humans:

1. Only start work on an issue with `scaffold:plan-approved` applied by a listed approver.
2. Link the PR to the issue ("Fixes #<issue>").
3. Keep the PR within `pr_size.soft` (exempt files not counted). Over it, split the work, or get a listed approver to agree an exception and record the reason on the PR.
4. Request review when the checks pass.

The hard size limit and the other baseline checks still apply.

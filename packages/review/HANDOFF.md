# Review handoff

The contract between review and the stages either side of it (PLAN.md section 5).

## Entry

An open PR from a member or Copilot, not a draft and not from a fork.

## Checks upstream

None: the plan gate and baseline checks are the implement package's and core's. `code-review` reads the linked issue, its triage brief, plan and approved scenarios, but doesn't gate on them.

## Exit

- **`code-review`:** one review per head commit, as `COMMENT` (never approve or request changes). Each comment starts with `<!-- scaffold:code-review -->` and names its axis (standards, spec or scenarios) and severity (blocking or suggestion). With review on, the review gate (implement package) waits until every code-review thread is resolved; its rework round lists the open ones for Copilot.
- **`ci-diagnose`:** when a run of a workflow listed in `ci_workflows` fails on the head commit, one diagnosis comment on the PR (starting `<!-- scaffold:ci-diagnosis <sha> -->`), updated in place for each new failing commit.

React 👎 to a code-review comment or a diagnosis that is wrong: the usage report counts it as a false positive.

## When review is off

`stages.review` is `false` or missing in `.github/scaffold-config.yml`. No code-review or diagnosis; the review gate doesn't wait for code-review threads. Humans:

1. Review the PR against the repo's standards, the issue (and its plan) and its approved scenarios before approving.
2. When CI fails, read the failed job's log and note the cause on the PR, so whoever fixes it (or Copilot) starts from it.

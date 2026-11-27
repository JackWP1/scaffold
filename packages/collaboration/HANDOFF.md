# Collaboration handoff

The contract between collaboration and the stages either side of it (PLAN.md section 5).

## Entry

- **Check 1:** a person applies `scaffold:plan-approved` (with plan off, by hand).
- **Check 2:** a PR linked to the issue ("Fixes #<issue>") gets an approving review that makes GitHub's review decision "approved" (its required reviews, e.g. code owners).

## Checks upstream

Finds in-flight tickets by `scaffold:planned` / `scaffold:plan-approved` (applied by hand when plan is off) and their affected paths from the plan comment. Reads plan approval and conflict state from the timeline, not from labels.

## Exit

- **No conflict:** the issue's status comment shows Conflicts ✅; after check 2, the PR gets a merge position (Merge order row) and a `<!-- scaffold:conflict-check-2 <sha> clean -->` record.
- **Conflict:** `scaffold:conflict` on the issue and one conflict comment (`<!-- scaffold:conflict -->`) linking every ticket involved. The plan gate (implement) and `scaffold-merge-order` fail while it's open. It's cleared only by a listed approver applying `scaffold:conflict-resolved` after the latest flag; removing `scaffold:conflict` by hand doesn't clear it. Other resolutions (sequence, replan, change the requirement, drop or merge tickets) are done by hand; sequencing is written as "Blocked by #<issue>" in the issue description, which merge order reads.
- **Merge order:** approved PRs with conflict-check 2 clean on their latest commit and no open conflict, ordered: tickets that block others first, stacked PRs bottom-up, priority, earliest approval. In the merge queue, `scaffold-merge-order` fails if a PR jumps the order, unless the `flow_lead` commented `/order-override <reason>` and applied `scaffold:order-override` after the PR got its position. An override never lifts a conflict.

## When collaboration is off

`stages.collaboration` is `false` or missing in `.github/scaffold-config.yml`. No conflict checks, flags or positions; `scaffold-merge-order` passes as "stage off: manual"; the plan gate ignores conflict flags. The flow lead:

1. After each plan approval, checks the other in-flight tickets (`scaffold:planned`, `scaffold:plan-approved`) for overlapping paths, spec sections or requirements, and agrees a resolution with the owners.
2. After each code-owner approval, checks the PR against other approved PRs and recent merges.
3. Orders merges by the rules above and tells developers when their PR is next.

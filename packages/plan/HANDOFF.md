# Plan handoff

The contract between plan and the stages either side of it (PLAN.md section 5). A manual handoff leaves the same state as the package, so implement (slice 3) works the same either way.

## Entry

`scaffold:ready` on the issue, and a member comments `/plan`.

## Checks upstream

- The issue carries `scaffold:ready`. Plan doesn't re-check how it got there, so the same label from a manual intake (`packages/intake/HANDOFF.md`) works the same.
- Scenarios (slice 2b): when they're required, plan will re-check the `scaffold:gherkin-approved` timeline, with intake on or off.

## Exit

One of:

- **Planned and approved:** one comment marked as the plan (it starts with `<!-- scaffold:plan -->`) and `scaffold:plan-approved`, applied by a listed approver in `scaffold-config.yml` who isn't the issue author, after the plan's last edit. The plan is one PR, or a stack of up to `max_stack_prs` PRs, each within the soft size limit. The issue counts as in flight (`max_in_flight`) from `/plan` until it merges, closes or goes back to Ready.
- **Too big:** the plan needs more than `max_stack_prs` PRs. The issue gets `scaffold:too-big`, leaves flight and goes back to triage, which proposes smaller tickets.

The plan gate re-checks the approval against the issue timeline; the label alone isn't trusted.

## When plan is off

`stages.plan` is `false` or missing in `.github/scaffold-config.yml`. SCAFFOLD doesn't admit, plan or gate; humans do:

1. Before planning, count open issues labelled `scaffold:planned` or `scaffold:plan-approved`. At `max_in_flight`, wait.
2. Apply `scaffold:planned` and remove `scaffold:ready`, so the ticket counts as in flight.
3. Write the plan as a comment from `packages/plan/templates/manual-plan.md`. Keep each PR within the soft size limit (`pr_size.soft`) and the stack within `max_stack_prs`, both from `.github/scaffold-config.yml`. If it needs more, apply `scaffold:too-big`, remove `scaffold:planned` and send it back to triage.
4. A listed approver who isn't the issue author reviews the plan and applies `scaffold:plan-approved`. Editing the plan afterwards needs a fresh approval.

## Turning plan on

Issues planned by hand before the commit that turned plan on keep going by hand: the gate marks them "manual (before `plan` was on)" and leaves their labels alone. Issues that reach `/plan` afterwards go through the package.

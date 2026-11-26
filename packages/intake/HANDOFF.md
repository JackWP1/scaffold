# Intake handoff

The contract between intake and the stages either side of it (PLAN.md section 5). A manual handoff leaves the same state as the package, so plan works the same either way.

## Entry

An issue opened from the Request form, or `scaffold:triage` applied to an existing issue (re-triage, including a ticket plan sent back as too big).

## Checks upstream

None: intake is the first stage.

## Exit

One of:

- `scaffold:ready`: a developer could plan the work without asking anything. The issue has a `priority:*` label and an agent-ready brief (goal, acceptance criteria, likely affected areas, out of scope).
- `scaffold:needs-info`: questions for the author in the status comment. The author answers them in the issue description, then applies `scaffold:triage`.
- `scaffold:proposed`: opened by someone outside the team; a member applies `scaffold:accepted` to triage it.
- `scaffold:too-big` (re-triage of a ticket plan sent back): smaller tickets proposed in the status comment. A member creates each as a new issue from the Request form, with its own Jira key, and closes the original as split.

`scaffold:no-template` flags an issue not created from the Request form; it doesn't block.

## When intake is off

`stages.intake` is `false` or missing in `.github/scaffold-config.yml`. SCAFFOLD doesn't triage; a member does, on each new issue:

1. Check the issue came from the Request form and has a Jira key. If not, ask the author to fix it.
2. If a developer couldn't plan it without asking anything, ask the author in a comment and apply `scaffold:needs-info`. Wait for answers.
3. Apply one `priority:*` label: `high` for security issues, data loss or a broken main path; `low` for cosmetic work; otherwise `medium`.
4. Write the brief in the issue (goal, acceptance criteria, affected areas, out of scope) if the form doesn't already say it.
5. Remove `scaffold:needs-info` and apply `scaffold:ready`.

For a ticket with `scaffold:too-big`: split it into smaller tickets from its plan comment, create each as a new issue, and close the original as split.

Limits that intake would enforce aren't enforced while it's off; the member doing triage applies them.

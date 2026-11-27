# Intake handoff

The contract between intake and the stages either side of it (PLAN.md section 5). A manual handoff leaves the same state as the package, so plan works the same either way.

## Entry

An issue opened from the Request form, or `scaffold:triage` applied to an existing issue (re-triage, including a ticket plan sent back as too big).

## Checks upstream

None: intake is the first stage.

## Exit

One of:

- `scaffold:ready`: a developer could plan the work without asking anything. The issue has a `priority:*` label and an agent-ready brief (goal, acceptance criteria, likely affected areas, out of scope). If scenarios are required, the issue also has an approved scenarios comment (below).
- `scaffold:needs-gherkin`: triaged, but scenarios are required and not yet approved. `gherkin` in `.github/scaffold-config.yml` decides: `always` requires them on every issue, `auto` when triage finds the issue changes behaviour, `off` never.
- `scaffold:needs-info`: questions for the author in the status comment. The author answers them in the issue description, then applies `scaffold:triage`.
- `scaffold:proposed`: opened by someone outside the team; a member applies `scaffold:accepted` to triage it.
- `scaffold:too-big` (re-triage of a ticket plan sent back): smaller tickets proposed in the status comment. A member creates each as a new issue from the Request form, with its own Jira key, and closes the original as split.

`scaffold:no-template` flags an issue not created from the Request form; it doesn't block.

### Scenarios

- **Comment:** one comment marked `<!-- scaffold:scenarios -->` holds the Gherkin in a ```` ```gherkin ```` fence. Each scenario is tagged `@scaffold-<issue>-S<n>` and numbered `S<n>` in order. Triage copies the Request form's Scenarios (Gherkin) field into it; Gherkin that doesn't parse isn't posted.
- **Approval:** a listed approver who isn't the issue author applies `scaffold:gherkin-approved` after the comment's last edit. The scenarios gate checks this against the timeline and that the Gherkin parses, then swaps `scaffold:needs-gherkin` for `scaffold:ready`. An invalid approval is removed.
- **Changes:** editing or deleting the comment, or removing `scaffold:gherkin-approved`, withdraws the approval and moves the issue back to `scaffold:needs-gherkin`. A planned issue keeps `scaffold:planned` but loses `scaffold:plan-approved`, and needs `/plan` again once the scenarios are re-approved.
- **Overrides:** under `auto`, a member with write access can add or remove `scaffold:needs-gherkin` to overrule triage. Under `always`, removing it puts it back.

## When intake is off

`stages.intake` is `false` or missing in `.github/scaffold-config.yml`. SCAFFOLD doesn't triage; a member does, on each new issue:

1. Check the issue came from the Request form and has a Jira key. If not, ask the author to fix it.
2. If a developer couldn't plan it without asking anything, ask the author in a comment and apply `scaffold:needs-info`. Wait for answers.
3. Apply one `priority:*` label: `high` for security issues, data loss or a broken main path; `low` for cosmetic work; otherwise `medium`.
4. Write the brief in the issue (goal, acceptance criteria, affected areas, out of scope) if the form doesn't already say it.
5. If scenarios are required (`gherkin: always`, or `auto` and the issue changes behaviour): apply `scaffold:needs-gherkin`, write them as a comment from `packages/intake/templates/manual-gherkin.md` (keep the marker and the `@scaffold-<issue>-S<n>` tags), and have a listed approver who isn't the issue author apply `scaffold:gherkin-approved`. Editing the comment afterwards needs a fresh approval.
6. Remove `scaffold:needs-info` and `scaffold:needs-gherkin`, and apply `scaffold:ready`.

For a ticket with `scaffold:too-big`: split it into smaller tickets from its plan comment, create each as a new issue, and close the original as split.

Limits that intake would enforce aren't enforced while it's off; the member doing triage applies them.

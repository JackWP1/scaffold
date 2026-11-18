# SCAFFOLD: Agentic Workflow on GitHub

**S**ecure, **C**ompliant **A**gentic **F**ramework **F**or **O**rchestrated **L**ifecycle **D**elivery: a reusable, versioned set of GitHub Actions and skills that assist humans across the issue → PR lifecycle, using only GitHub automation and OpenAI models. It adapts the governance and tooling of [Hospital](../hospital-workflow) to these constraints.

## 1. Constraints

| Constraint | Consequence |
| --- | --- |
| GitHub automation only: Actions, native features (rulesets, CODEOWNERS, environments, labels, issue forms) and Copilot agents | No external services, gateways or MCP servers; no self-hosted infrastructure |
| OpenAI models only | Actions call OpenAI models via Copilot CLI with no tools (GitHub Models was retired on 2026-07-30); the Copilot coding agent is set to an OpenAI model |
| No GitHub App, no PAT | Jobs use `GITHUB_TOKEN` only: no cross-repo writes, no edits to `.github/workflows/`, no ruleset creation. Installs are self-service (section 5) |
| Org: `ukncsc` | Hosting (assumed Enterprise Cloud), org-billed Copilot CLI from Actions and approved models are confirmed in Phase 0 |

## 2. What SCAFFOLD does (v1)

SCAFFOLD assists; humans decide. Actions steps are **single-shot**, tool-less Copilot CLI calls that return schema-validated JSON; Actions code (not the model) applies comments, labels and checks. **Only the Copilot coding agent writes code**, and only on issues a human assigns to it.

| Trigger | Skill | Output |
| --- | --- | --- |
| `issues: opened`, `scaffold:triage` applied | `triage` | Labels, clarifying questions, agent-ready brief |
| `issue_comment` `/plan` | `task-decomposer` | Plan comment: approach, sub-tasks with blocking edges, acceptance criteria, affected paths, estimated size; work over the soft size limit is split into a stack of PRs or up to 5 sub-tickets (section 6) |
| After plan approval (before implementation); after code-owner approval (before merge order) | `conflict-check` | `scaffold:conflict` and one conflict comment linking every ticket involved (section 8) |
| `pull_request` | `code-review` | Review comments (standards + spec axes); `COMMENT` only, never approves; human review waits until they are resolved (section 6) |
| `workflow_run` (failed, workflows listed in `scaffold.yml`) | `ci-diagnose` | Diagnosis comment on the linked PR |
| Human assigns issue to Copilot | `tdd`, `implement` (via `.github/skills/`) | Copilot PR, reviewed and merged by humans |
| `schedule` (weekly) | — | Usage report issue (section 7) |

### Issue lifecycle

1. Issue opened → `triage` (members only, section 6) → `scaffold:triage` / `scaffold:needs-info` / `scaffold:ready`. Triage adds `scaffold:no-template` if the issue wasn't created from the Request template, and removes it once the template's headings are there. On `needs-info`, the author answers the questions in the issue description, then applies `scaffold:triage` to re-run triage.
2. Member comments `/plan` → plan comment → `scaffold:planned`. A new `/plan` replaces the plan comment and withdraws any approval.
3. Human reviews plan → applies `scaffold:plan-approved` → the plan gate checks it against the timeline and removes it if the approval isn't valid. On a valid approval of a sub-ticket split, Actions creates the sub-issues.
4. Human assigns issue to Copilot → Copilot opens PR.
5. Guard checks (section 6), CI and `code-review` → SCAFFOLD automatically starts a Copilot rework round, with no human approval, until checks pass and all `code-review` comments are resolved → code-owner review → `conflict-check` 2 → merge order → developer adds the PR to the merge queue when it is next → merged.
6. 6 rework rounds used → circuit breaker: `scaffold:escalate` and straight to human review.
7. Throughout, each ticket is checked against other in-flight work and the existing spec; conflicts and regression risks go to the Conflicts queue for human review (section 8).

### Labels

Colour shows what kind of label it is, so a glance at an issue says whether it needs a human. Synced from `config/labels.yml`; `tests/triage.test.mjs` fails if the two drift apart. Add or change labels in both places.

| Group | Meaning | Labels | Colour |
| --- | --- | --- | --- |
| Lifecycle | Where the issue is | `scaffold:triage` | `ededed` grey |
| | | `scaffold:needs-info` | `fbca04` yellow |
| | | `scaffold:ready` | `0e8a16` green |
| | | `scaffold:planned` | `c5def5` light blue |
| | | `scaffold:plan-approved` | `1d76db` blue |
| Intake | Waiting for a member to accept | `scaffold:proposed` | `fef2c0` pale yellow |
| Attention | A human must act | `scaffold:escalate` | `b60205` red |
| | | `scaffold:conflict` | `d93f0b` orange |
| Flag | Worth a look; doesn't block | `scaffold:no-template` | `f9d0c4` pale orange |
| Override | A member or approver lifted a gate | `scaffold:accepted` | `d4c5f9` pale purple |
| | | `scaffold:conflict-resolved` | `d4c5f9` pale purple |
| | | `scaffold:size-exception` | `d4c5f9` pale purple |
| | | `scaffold:order-override` | `d4c5f9` pale purple |
| | | `scaffold:diagram-unchanged` | `d4c5f9` pale purple |
| Priority | Set by `triage` | `priority:high` | `5319e7` dark purple |
| | | `priority:medium` | `8a63d2` purple |
| | | `priority:low` | `c9b8f0` light purple |

## 3. Skills

- Each skill is a folder: `skills/<name>/SKILL.md` (YAML frontmatter: `name`, `description`, `inputs`, `outputs`, `tier`; body: instructions, constraints, output schema, definition of done), plus optional `examples/`.
- Output schemas live in `schemas/`; every model response is validated with ajv before any write. Invalid output → neutral check + comment, no writes.
- Adapted (MIT, attributed) from the mattpocock skills vendored in Hospital:

| SCAFFOLD skill | Source | Used by |
| --- | --- | --- |
| `triage` | `triage` | Actions |
| `task-decomposer` | `to-tickets` | Actions (`/plan`) |
| `code-review` | `code-review` | Actions |
| `ci-diagnose` | `diagnosing-bugs` (no HITL script) | Actions |
| `conflict-check` | New | Actions |
| `tdd`, `implement` | `tdd`, `implement` | Copilot coding agent via `.github/skills/` |

- Prompts include the repo's `PRECEDENTS.md` and charter; issue and PR text is wrapped and marked as untrusted data.
- Skills are tested in CI with fixed inputs and expected outputs, versioned with semver tags and a `CHANGELOG.md`.

### Model tiers

`skills/manifest.yml` maps each skill to a tier; one file maps tiers to OpenAI model IDs for Copilot CLI. A CI check rejects non-OpenAI IDs.

| Tier | Skills |
| --- | --- |
| `fast` | `triage` |
| `standard` | `task-decomposer`, `ci-diagnose` |
| `deep` | `code-review`, `conflict-check` |

Concrete models are chosen in Phase 0.

## 4. Carried over from Hospital

| Hospital | SCAFFOLD |
| --- | --- |
| `hospital:*` state labels | Simplified `scaffold:*` labels (section 2) |
| `policies/CHARTER.md` | `policies/CHARTER.md`: plan before code, don't improvise, test integrity, protected paths, spec is source of truth, precedent first, untrusted input, structured notes, circuit breaker (6 automatic rework rounds → `scaffold:escalate` and human review) |
| `hospital.config.yml` in a separate config repo + registration check | `.github/scaffold.yml` **in each repo** (a separate config repo can't be read without an App/PAT), protected by CODEOWNERS |
| `recommendations.yml` + deviations + history | Same: versioned recommendations; each deviation needs a reason; released history immutable |
| `config-guard` | `scaffold-config-guard` check on PRs touching `scaffold.yml`; runs on `pull_request`, never on `pull_request_target` with PR code |
| Templates | Issue forms, PR template (test-integrity checkboxes), CODEOWNERS snippet, spec skeleton, `PRECEDENTS.md` (human-written only) |
| Self-test suite | vitest with fake GitHub, workflow-property tests, actionlint, markdownlint, shellcheck, dist-freshness check, actions pinned by SHA |
| TypeScript libs (`config-guard`, `github.ts` REST client, `fake-github.ts`) | Ported; bundled to `dist/*.mjs` and run by composite actions with node |

**Not carried over:** GitHub App and App-only required checks, local `bootstrap.sh` with admin `gh`, Claude plugin/skills/hooks, `claude-code-action`, LiteLLM gateway, Figma MCP, autonomous multi-stage pipeline.

## 5. Repo layout and distribution

Central repo: `ukncsc/scaffold` (internal), Actions access set to "Accessible from repositories in the organization". Built in `JackWP1/scaffold` until moved before the pilot.

```text
.github/workflows/      reusable workflows (workflow_call) + self-test
actions/<name>/         composite actions; bundle skills, prompts, schemas and dist/
skills/                 SKILL.md sources + manifest.yml
schemas/                output and scaffold.yml JSON schemas
config/                 labels.yml, recommendations.yml, models.yml, workflow.yml
policies/CHARTER.md
templates/              caller workflow, scaffold.yml, Copilot instructions, issue/PR templates, CODEOWNERS snippet
docs/                   INSTALL.md, ARCHITECTURE.md, CONTRIBUTING-SKILLS.md
docs/diagrams/          Mermaid workflow and architecture diagrams (section 10)
src/ tests/ dist/       TypeScript glue, tests, bundled output
```

- Skills and prompts ship **inside composite actions**, so the runner fetches them at the pinned ref; no cross-repo checkout token needed.
- Consumers call `uses: ukncsc/scaffold/.github/workflows/<x>.yml@v1`; Dependabot bumps the pin.

### Self-install (no App, no PAT)

1. Repo admin copies the thin caller `.github/workflows/scaffold.yml` and `.github/scaffold.yml` from `templates/` (later: org starter workflow). The issue template comes from the `.github` repo (below).
2. Admin follows the `INSTALL.md` checklist: labels (or run the `scaffold-labels` job), ruleset (PRs only, code-owner review, dismiss stale approvals on push, required SCAFFOLD checks, no bypass), CODEOWNERS block, Copilot settings (section 6), secret scanning + push protection.
3. A `scaffold-sync` job in the target repo opens a PR (via `GITHUB_TOKEN`) to add/update Copilot instruction files, `.github/skills/`, templates and `.scaffold-version`. Workflow files are never touched by automation.
4. Requires org setting "Allow GitHub Actions to create and approve pull requests". PRs opened by `GITHUB_TOKEN` don't trigger workflows; a human re-runs checks on them.

### Issue template

The Request form ships once, as an account/org default in the `.github` repo (`JackWP1/.github`, later `ukncsc/.github`), not per repo. Every repo without its own `.github/ISSUE_TEMPLATE/` uses it.

- **Source:** `templates/caller/.github/ISSUE_TEMPLATE/request.yml` here; the `.github` repo holds a copy, changed only by reviewed PR.
- **No pinning:** GitHub serves defaults live from the `.github` repo's default branch, while triage is pinned to a release. So fields are **only added, never renamed or removed**: triage's template check (`actions/triage/template.mjs`) must keep matching issues from both old and new forms. A test fails if a checked heading is missing from the form.

## 6. Guardrails

### Trust

- AI steps run only when `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. Others get `scaffold:proposed`; a member applies `scaffold:accepted` to proceed.
- Issue/PR text is untrusted: delimited in prompts, never executed, outputs schema-validated; comments escape @-mentions and HTML.
- No `pull_request_target` with PR checkout; least-privilege `permissions:` per job; actions pinned by SHA.

### Copilot coding agent

All of these are required checks.

- **Plan gate:** fails if the linked issue lacks `scaffold:plan-approved`.
- **Protected paths:** fails if the PR touches `.github/**`, `.github/scaffold.yml`, `CODEOWNERS`, `PRECEDENTS.md` or `docs/spec/**`; CODEOWNERS is the second layer.
- **Test integrity:** flags removed/skipped tests, removed assertions or reduced coverage; needs a human label to pass.
- **PR size:** counts changed files and changed lines (additions + deletions) per PR, excluding exempt files. Limits are set in `scaffold.yml`:

  | Limit | Files | Lines |
  | --- | --- | --- |
  | Soft | 10 | 1000 |
  | Hard | 30 | 5000 |

  - **Exempt files:** a glob list in `scaffold.yml` (default: lock files such as `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, and generated `dist/`). Changes to the list need code-owner review like the rest of `scaffold.yml`.
  - **At plan:** `task-decomposer` estimates the size; work over the soft limit is planned as a stack of PRs or up to 5 sub-tickets, and the approver confirms the split with the plan.
  - **Over soft:** the review gate fails and the automatic rework round asks Copilot to split the PR into a stack of PRs (GitHub stacked PRs, each layer checked against the limits). Splitting into sub-tickets instead is a replan: it goes back to the approver and the ticket returns to `Ready`.
  - **Over hard:** a required check fails, so the PR can't merge even after human review or with a size exception; it must be split.
  - **Sub-tickets:** at most 5 per ticket, created as GitHub sub-issues under the parent, and only from an approved plan. The plan gate passes a sub-ticket when its parent's approval is valid (read via the sub-issue's parent); editing the parent's plan fails all its open sub-tickets until it is re-approved. Replanning any sub-ticket replans the parent: the parent goes back to `Ready` and merged sub-tickets stay merged. Needing more than 5 means the ticket is too big: it goes back to the approver to replan or split in Jira.
  - **Exceptions:** lift the soft limit only. Only a listed approver can grant one, by applying `scaffold:size-exception` (timeline check, as for plan approval). Requested by a developer commenting `/size-exception <reason>`, or automatically with `scaffold:escalate` when the circuit breaker trips on an oversized PR.
- **Review gate:** a human reviewer is requested only when guard checks and CI pass, every `code-review` comment is resolved and the PR is within the soft size limit (or has an exception), or the circuit breaker trips.
- **Automatic rework:** when the review gate fails, Actions posts one `@copilot` comment listing the failing checks and unresolved `code-review` threads. No human approves the round.
- **Circuit breaker:** after 6 automatic rework rounds, counted across the PR's whole life (including rounds after a merge queue failure or re-review) → `scaffold:escalate` and hand to human review.
- Copilot firewall on the default allowlist. "Require approval for workflow runs" is turned off for the Copilot agent so rework rounds run checks without a human; protected paths, the review gate and code-owner review stay required.

### Handover gates

Every handover between a human, an agent or a stage is a gate. Gates are **protected** (only the right actor can pass them), **deterministic** (Actions code decides, not a model) and **monitor-able** (every pass or fail is recorded).

| Gate | Passed by | Protection | Evidence |
| --- | --- | --- | --- |
| Triaged → ready | `triage` Action applies `scaffold:ready` | Members-only trigger; schema-validated output | Audit log, issue label |
| Ready → planned | Member comments `/plan` | `author_association` check; in-flight count below `max_in_flight` | Plan comment, audit log |
| Planned → approved | Developer applies `scaffold:plan-approved` | Plan gate reads the issue timeline: label must be applied by a listed approver in `scaffold.yml` (not the issue author or a bot), and the plan comment must be unchanged since approval (its last edit is before the label event; the plan hash is recorded in the audit log); the plan must pass the size rules; an invalid approval is removed; sub-tickets use the parent's approval | Timeline event, status comment, audit log; check run from slice 3 |
| Approved → implementing | Developer assigns issue to Copilot | Plan gate on the resulting PR | Copilot PR |
| Oversized PR → exception | Listed approver applies `scaffold:size-exception` | Timeline check; lifts the soft limit only; requested via `/size-exception <reason>` or automatic `scaffold:escalate` | Escalation, timeline event, reason in status comment |
| Review gate fails → rework | Actions, automatically | Round counter in Actions code; stops after 6 | `@copilot` comment, rework count in status comment |
| Copilot PR → human review | Review gate check | Actions code counts unresolved `code-review` threads and rework rounds; reviewer requested only on pass | Check run, rework count in status comment |
| Merge order → override | Flow lead applies `scaffold:order-override` | Timeline check: label applied by the `flow_lead` in `scaffold.yml` after the PR's current merge position and latest push, with a `/order-override <reason>` comment by the flow lead; never lifts an open conflict | Timeline event, reason in status comment and audit log |
| Conflict flagged → cleared | Listed approver applies `scaffold:conflict-resolved`, or the blocking ticket merges | Plan gate and `merge-order` check fail while `scaffold:conflict` is open; timeline check: label applied by a listed approver after the latest flag | Conflict comment, timeline event |
| PR → mergeable | Required checks + code-owner review + second `conflict-check` + merge queue | Ruleset, no bypass; `merge-order` check | Check runs, review, merge position, merge queue run |

- Labels alone are not protection: anyone with triage permission can apply them. The check that reads the timeline is the protection.
- Each issue has one SCAFFOLD **status comment**, updated in place, showing passed and pending gates (as a Mermaid diagram, section 10).

## 7. Operations

- **Kill switch:** org/repo variable `SCAFFOLD_ENABLED=false` skips all AI steps.
- **Rate guards:** concurrency group per issue/PR, input size cap, Copilot rate limit → neutral check + comment (never a failure).
- **Audit log:** per AI step, record skill, version, model, input hash and validated output to the job summary and a 90-day artifact. Prompt bodies are not logged.
- **Usage report:** weekly scheduled job posts runs per skill and repo to an issue (pilot metrics: cost, false positives).

## 8. Humans in the loop

Humans are the slow part of the workflow; agents are not. SCAFFOLD is designed to spend human time and attention only where a decision is needed.

**Assumption (v1):** up to 6 developers per project and no other humans in the loop. Non-developer roles are deferred (below).

- **One prioritised queue:** a GitHub Projects board per project with `Status` (mirrors the gates in section 6), `Priority`, `Size` and `Iteration` fields. Developers pull from the top of `Ready`; they don't choose from the full backlog. Priority is set with a `priority:*` label so Actions can read it (merge order, below).
  - `GITHUB_TOKEN` can't write to Projects, so SCAFFOLD only sets labels; the board uses Projects' built-in workflows (auto-add by label, set status on close/merge).
- **Flow lead:** a rotating developer (weekly), named in `scaffold.yml` (`flow_lead`, changed by PR at each rotation so code-owner review protects it), orders the backlog, runs `/plan` on the next items and watches `scaffold:escalate` and the Conflicts queue.
- **Work-in-progress limits:**
  - **Per developer:** `scaffold.yml` sets a maximum number of open Copilot PRs per developer (default 2). Going over gets a comment, not a block.
  - **Total in flight:** `scaffold.yml` sets `max_in_flight`, the maximum number of tickets in flight per project at once (assume 20; to be agreed). A ticket is in flight from its `/plan` until its PR merges (Actions counts open issues labelled `scaffold:planned` or `scaffold:plan-approved`), it closes or it goes back to `Ready` (it then needs `/plan` again). A split ticket counts as 1 and stays in flight until all its sub-tickets have merged or closed; the parent then closes automatically. At the limit, `/plan` is refused with a comment and the ticket waits at the top of `Ready`; when a slot frees up, Actions @-mentions the flow lead on the top waiting ticket (Actions never runs `/plan` itself). This is a block, and it also bounds the work `conflict-check` compares against.
- **Review routing:** CODEOWNERS plus team auto-assignment (round robin) so no PR waits without a reviewer.
- **Low-noise output:** SCAFFOLD updates one status comment per issue or PR rather than posting new comments, and only @-mentions a human when a gate needs them.

### Concurrent work and conflicts

Several tickets are in development at once. SCAFFOLD checks each one against the others and against existing code so that conflicts reach a human early rather than at merge. See `docs/diagrams/collaboration.md`.

- **When:** twice per ticket. Once after plan approval, before implementation starts (requirements and plan). Once after code-owner approval, before the PR gets a merge position (approved code).
- **Find (deterministic):** Actions code shortlists candidates: other in-flight tickets with the same spec section, Jira epic or affected paths; for the second check, other approved PRs and changes merged since the first check. This keeps model input small.
- **Judge (AI):** `conflict-check` compares the ticket with the shortlist and with `docs/spec/` and `PRECEDENTS.md`, and reports each conflict or regression risk with the tickets and spec sections involved.
- **Regression in code:** the full test suite and test integrity check run on every PR; a **merge queue** tests each PR together with main and the PRs ahead of it before it merges. If a PR fails in the queue, Actions re-runs its tests with just main: a pass means the failure comes from the PRs ahead and is flagged as a conflict; a fail sends the PR to automatic rework. A reworked PR leaves the merge order and goes round again: guard checks, CI and the review gate re-run, the new push dismisses the code-owner approval so it must be re-approved, and `conflict-check` 2 runs again before it gets a new position.
- **Merge queue checks:** every required SCAFFOLD check also runs on `merge_group`; checks that only apply to PRs (plan gate, PR size, review gate) pass straight away there.
- **Flag:** Actions applies `scaffold:conflict`, removes any `scaffold:conflict-resolved`, and keeps one conflict comment, linking every ticket involved, up to date. The plan gate and the `merge-order` check fail while the flag is open, so the ticket can't be implemented or merged, and a flagged PR leaves the merge order.
- **Queue:** a Projects "Conflicts" view lists flagged tickets by priority. The flow lead watches it with the owners of the tickets involved.
- **Resolve:** a human chooses one of: no real conflict (a listed approver applies `scaffold:conflict-resolved`; it counts only if applied after the latest flag), sequence (mark as blocked by the other ticket; resumes when it merges), replan, change the requirement, or drop or merge tickets.
- **Merge order:** after the second check passes, Actions gives each approved PR without an open conflict a position (a flagged PR gets a new one when its conflict is cleared), shown in its status comment:
  1. PRs that block other tickets first;
  2. stacked PRs bottom-up;
  3. higher priority (`priority:*` label);
  4. earliest code-owner approval.

  The developer adds the PR to the merge queue when it is next. A `merge-order` check in the merge queue fails if a PR jumps the order or has an open conflict.
  - **Override:** the flow lead can let a PR go out of order. They comment `/order-override <reason>` and apply `scaffold:order-override`. The `merge-order` check reads the timeline and accepts the override only if both were made by the `flow_lead` in `scaffold.yml` after the PR's current merge position and latest push; otherwise it fails. A new position or push makes the override stale. The override never lifts an open conflict. The reason is recorded in the status comment and the audit log.

### Deferred (later iteration)

- **Non-developer roles:** up to 6 further humans (e.g. product, delivery, assurance). Define their gates, such as requirements sign-off, plan approval and acceptance, once the developer-only workflow is working.

## 9. Requirements and Jira

### Source of truth

Proposed split, to be confirmed in Phase 0:

| Content | Source of truth | Changed by |
| --- | --- | --- |
| Product requirements (what and why) | Jira | Jira workflow |
| Agreed specification (how) | `docs/spec/` in the repo | PR with code-owner review (protected path, section 6) |
| Unit of work | GitHub Issue, linked to the Jira key and spec section | SCAFFOLD lifecycle (section 2) |

### Jira ↔ GitHub

The constraints (section 1) rule out SCAFFOLD holding Jira credentials, so the options are:

| Option | Direction | Fits constraints? |
| --- | --- | --- |
| Issue form with a required Jira key field; content pasted in; `triage` checks the key format | Jira → GitHub | Yes |
| Jira key in branch names and PR titles, surfaced by Atlassian's "GitHub for Jira" app | GitHub → Jira | Needs org approval of a third-party GitHub App |
| Jira Automation rule calls `repository_dispatch` to create the issue | Jira → GitHub | No: needs a token stored in Jira; exception required |

Start with the issue form and Jira keys in PR titles; revisit after the first slices.

## 10. Diagrams

Diagrams are both an output (what the repo and workflow are doing) and an input (a way to propose changes). They are kept as code so they can be diffed, reviewed and read by agents.

- **Format:** Mermaid in Markdown, which GitHub renders natively in files, issues and PRs.
- **`docs/diagrams/workflow.md`** holds two diagrams:
  - **Proposed:** the target lifecycle, coloured by the slice that delivers each step; delivered steps change from a red to a blue outline. Hand-maintained. A PR that changes it is a proposal to change the workflow; once merged, the implementing work follows from it.
  - **Current:** the workflow as implemented. Updated in every slice's PR, so its git history records how the workflow changed. A history table lists each slice's change.
- **`docs/diagrams/collaboration.md`:** how concurrent tickets are checked for conflicts and regressions (section 8), with the development loops simplified. Proposed diagram only until slice 5 adds a Current one.
- **`docs/diagrams/architecture.md`:** components and how they call each other; updated in the same way.
- **Workflow definition:** `config/workflow.yml` describes the implemented workflow (stages, gates, labels, triggers, skills, required checks). The Current diagram, the label state machine and the Actions workflow graph are generated from it and from `labels.yml` and `.github/workflows/*.yml`.
- **`scaffold-diagrams` check** (required): fails if the workflow changes without the diagram changing with it.
  - Generated diagrams differ from the committed ones (as with `dist/`).
  - `workflow.yml` disagrees with the implementation: labels in `labels.yml`, triggers and skills in `.github/workflows/*.yml`, gate checks in the ruleset template.
  - **Before code exists:** a PR that changes the workflow in this plan (sections 2, 6 or 8) without changing a diagram in `docs/diagrams/` fails; an approver can pass it by applying `scaffold:diagram-unchanged`.
- **Per issue:** the status comment (section 6) shows the issue's position in the workflow as a Mermaid diagram.
- **Later:** a `diagram-to-mermaid` skill turning sketches or whiteboard photos attached to issues into a Mermaid draft for a human to correct. Depends on Copilot CLI image input and reading issue attachments with `GITHUB_TOKEN` (confirm in Phase 0).

## 11. Plan

The workflow is built in **vertical slices**: each slice adds one stage end to end, including its visibility (below), runs it on real issues, and ends with a retrospective that updates this plan. The workflow is expected to change as we learn how it flows and how people work with it. Each slice also lists what it teaches about GitHub Actions and Issues.

### Phase 0: Scope and governance

- Confirm with `ukncsc` admins: hosting (Enterprise Cloud vs GHE.com vs GHES), Copilot CLI billed to the organisation from Actions (`copilot-requests: write`, including image input), Copilot coding agent enabled with OpenAI models, org Actions settings.
- Choose OpenAI model IDs for `fast`, `standard`, `deep`.
- Agree the data-handling rule with security and data owners (e.g. opt-in per repo, classification limits, logging position).
- Confirm the source-of-truth split and the Jira route (section 9), including whether "GitHub for Jira" is allowed.
- Choose the pilot repos and the 6 developers; agree the flow lead rota and work-in-progress limits, including `max_in_flight` (assumed 20) (section 8).
- Confirm the current workflow and the proposed lifecycle in `docs/diagrams/workflow.md` and `docs/diagrams/collaboration.md` (first drafts committed).
- Add the plan-stage `scaffold-diagrams` check (section 10) so changes to this plan's workflow must update the diagram.
- Confirm the human approval points in section 2.
- Confirm Copilot acts on `@copilot` comments posted by `github-actions[bot]`; GitHub only documents it responding to users with write access. If it doesn't, automatic rework needs an exception to section 1 (a GitHub App or service account), or the assigning developer prompts each round.
- Confirm Copilot can't change `.github/workflows/` before turning off workflow-run approval for it.
- Confirm the Copilot coding agent can create stacked PRs (the `gh-stack` skill in its setup steps); otherwise oversized work is always split into sub-tickets. Confirm `GITHUB_TOKEN` can create sub-issues.
- Agree the PR size limits and exempt file list (section 6).
- Confirm merge queue is available on the pilot repos and whether `GITHUB_TOKEN` can set "blocked by" issue relationships (otherwise a human sets them); agree the merge queue status check timeout.

### Phase 1: Foundations

Only what slice 1 needs.

- Scaffold the layout (section 5); port Hospital's TS libs, tests and self-test workflow.
- Write `CHARTER.md`, `labels.yml`, `scaffold.yml` schema and config-guard.
- Add kill switch, rate guards and audit logging.
- Add CODEOWNERS, branch and `v*` tag rulesets, semver releases.
- Create `scaffold-sandbox` with fixture issues and PRs, including prompt-injection cases; it is the end-to-end test for every slice.

### Phase 2: Vertical slices

Each slice: build → run in the sandbox → run on the pilot repo → retrospective → PR to this plan.

| Slice | Adds | Visibility | Learn |
| --- | --- | --- | --- |
| 1. Intake | Jira issue form, `triage`, labels, Projects board | Status comment, audit log and job summary, weekly usage report, `workflow.yml` with generated diagrams and the `scaffold-diagrams` check | Issue forms, labels, Projects; workflow triggers, `permissions:`, `GITHUB_TOKEN`, job summaries, `schedule`, artifacts, `workflow_dispatch` |
| 2. Plan | `/plan`, `task-decomposer`, protected plan gate, size estimate and split into sub-tickets | Plan gate in the status comment; gate passes and fails in the audit log; time to approval in the usage report | `issue_comment` events, reusable workflows, composite actions, required checks, rulesets |
| 3. Implement | Copilot assignment, `tdd`/`implement` skills, protected paths, test integrity, PR size limits and exceptions, stacked PRs, circuit breaker, work-in-progress limits | PR status comment with guard checks, size and rework count; size exceptions in the usage report; work in progress per developer in the usage report | Copilot coding agent, CODEOWNERS, `pull_request` events, stacked PRs, sub-issues |
| 4. Review | `code-review`, `ci-diagnose` | Review and diagnosis outcomes and false positives in the usage report | `pull_request` vs `pull_request_target` security, `workflow_run` |
| 5. Collaboration | `conflict-check`, conflict flag and gate, Conflicts queue, merge order, merge queue | Conflicts in the status comment; Conflicts queue length and time to resolve, repeat flags per ticket, and false positives, in the usage report | Merge queue, `merge_group` events, `push` events, issue relationships (blocked by) |

### Visibility in every slice

A slice is not done until, in its own PR:

- the Current diagram matches what was built and its steps in the Proposed diagram are marked done (`scaffold-diagrams` passes);
- `workflow.yml` and the architecture diagram include the new stage, gates and checks;
- the status comment shows the new gate;
- the audit log and usage report include the new skill or gate;
- the retrospective adds a row to the diagram history and any workflow changes to the Proposed diagram.

- Move to `ukncsc/scaffold` (internal) and set Actions access before the first pilot-repo run.
- Measure per slice: human time per gate, queue length at each gate, false positives, cost.

### Phase 3: Install path

- Write `templates/` (caller, `scaffold.yml`, Copilot instructions, issue/PR templates, CODEOWNERS snippet).
- Write `INSTALL.md` checklist and the `scaffold-labels` and `scaffold-sync` jobs.
- Install on further pilot repos.

### Phase 4: Upgrade path

- Dependabot for `@vN` pins; `scaffold-sync` PRs for non-workflow files, reporting locally edited files rather than overwriting.
- Write docs and `CONTRIBUTING-SKILLS.md`.

### Phase 5: Org-level starter workflow

- Publish the thin caller as `ukncsc/.github/workflow-templates/scaffold.yml` with its properties file.
- Keep reusable workflows and skills in `ukncsc/scaffold`.
- Optionally enforce via org rulesets (required SCAFFOLD checks) once the pilot is stable.

## 12. Risks

- **Prompt injection:** members-only triggers, untrusted-input handling, single-shot JSON outputs, no code-writing outside Copilot.
- **Platform availability:** Org-billed Copilot CLI or Copilot OpenAI models may not be enabled for `ukncsc`; Phase 0 blocks on confirmation.
- **Rate limits and cost:** tiers, rate guards, kill switch, usage report.
- **Non-deterministic output:** schema validation; invalid output never writes.
- **`GITHUB_TOKEN` limits:** sync PRs don't trigger workflows; workflow files and rulesets need a human admin.
- **Skill drift:** pinned versions, Dependabot, `.scaffold-version`.
- **Data handling:** unresolved until Phase 0.
- **Human bottleneck:** review queues grow faster than developers can clear them; work-in-progress limits, one prioritised queue and per-gate metrics (sections 8 and 11).
- **Diagram drift:** pictures stop matching the workflow; `scaffold-diagrams` is a required check and every slice updates the diagrams (sections 10 and 11).
- **Automatic rework may not be possible:** Copilot may ignore `@copilot` comments from Actions; Phase 0 tests this before slice 3.
- **Noisy conflict flags:** too many false positives and developers ignore the queue; deterministic shortlist first, track false positives per slice, tune `conflict-check`.
- **Two sources of truth:** Jira and `docs/spec/` drift; agreed split and Jira keys on every issue and PR (section 9).

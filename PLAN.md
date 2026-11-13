# SCAFFOLD: Agentic Workflow on GitHub

**S**ecure, **C**ompliant **A**gentic **F**ramework **F**or **O**rchestrated **L**ifecycle **D**elivery: a reusable, versioned set of GitHub Actions and skills that assist humans across the issue → PR lifecycle, using only GitHub automation and OpenAI models. It adapts the governance and tooling of [Hospital](../hospital-workflow) to these constraints.

## 1. Constraints

| Constraint | Consequence |
| --- | --- |
| GitHub automation only: Actions, native features (rulesets, CODEOWNERS, environments, labels, issue forms) and Copilot agents | No external services, gateways or MCP servers; no self-hosted infrastructure |
| OpenAI models only | Actions call OpenAI models via GitHub Models; the Copilot coding agent is set to an OpenAI model |
| No GitHub App, no PAT | Jobs use `GITHUB_TOKEN` only: no cross-repo writes, no edits to `.github/workflows/`, no ruleset creation. Installs are self-service (section 5) |
| Org: `ukncsc` | Hosting (assumed Enterprise Cloud), GitHub Models availability and approved models are confirmed in Phase 0 |

## 2. What SCAFFOLD does (v1)

SCAFFOLD assists; humans decide. Actions steps are **single-shot** GitHub Models calls that return schema-validated JSON; Actions code (not the model) applies comments, labels and checks. **Only the Copilot coding agent writes code**, and only on issues a human assigns to it.

| Trigger | Skill | Output |
| --- | --- | --- |
| `issues: opened/edited` | `triage` | Labels, clarifying questions, agent-ready brief |
| `issue_comment` `/plan` | `task-decomposer` | Plan comment: approach, sub-tasks with blocking edges, acceptance criteria |
| `pull_request` | `code-review` | Review comment (standards + spec axes); `COMMENT` only, never approves, non-blocking during pilot |
| `workflow_run` (failed, workflows listed in `scaffold.yml`) | `ci-diagnose` | Diagnosis comment on the linked PR |
| Human assigns issue to Copilot | `tdd`, `implement` (via `.github/skills/`) | Copilot PR, reviewed and merged by humans |
| `schedule` (weekly) | — | Usage report issue (section 7) |

### Issue lifecycle

1. Issue opened → `triage` (members only, section 6) → `scaffold:triage` / `scaffold:needs-info` / `scaffold:ready`.
2. Member comments `/plan` → plan comment.
3. Human reviews plan → applies `scaffold:plan-approved`.
4. Human assigns issue to Copilot → Copilot opens PR.
5. Guard checks (section 6) + `code-review` → human review → human merge.
6. Stuck or circuit breaker tripped → `scaffold:escalate`.

### Labels

`scaffold:triage`, `scaffold:needs-info`, `scaffold:ready`, `scaffold:plan-approved`, `scaffold:proposed`, `scaffold:accepted`, `scaffold:escalate`.

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
| `tdd`, `implement` | `tdd`, `implement` | Copilot coding agent via `.github/skills/` |

- Prompts include the repo's `PRECEDENTS.md` and charter; issue and PR text is wrapped and marked as untrusted data.
- Skills are tested in CI with fixed inputs and expected outputs, versioned with semver tags and a `CHANGELOG.md`.

### Model tiers

`skills/manifest.yml` maps each skill to a tier; one file maps tiers to OpenAI model IDs on GitHub Models. A CI check rejects non-OpenAI IDs.

| Tier | Skills |
| --- | --- |
| `fast` | `triage` |
| `standard` | `task-decomposer`, `ci-diagnose` |
| `deep` | `code-review` |

Concrete models are chosen in Phase 0.

## 4. Carried over from Hospital

| Hospital | SCAFFOLD |
| --- | --- |
| `hospital:*` state labels | Simplified `scaffold:*` labels (section 2) |
| `policies/CHARTER.md` | `policies/CHARTER.md`: plan before code, don't improvise, test integrity, protected paths, spec is source of truth, precedent first, untrusted input, structured notes, circuit breaker (4 consecutive / 6 total rework rounds → `scaffold:escalate`) |
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
config/                 labels.yml, recommendations.yml, models.yml
policies/CHARTER.md
templates/              caller workflow, scaffold.yml, Copilot instructions, issue/PR templates, CODEOWNERS snippet
docs/                   INSTALL.md, ARCHITECTURE.md, CONTRIBUTING-SKILLS.md
docs/diagrams/          Mermaid workflow and architecture diagrams (section 10)
src/ tests/ dist/       TypeScript glue, tests, bundled output
```

- Skills and prompts ship **inside composite actions**, so the runner fetches them at the pinned ref; no cross-repo checkout token needed.
- Consumers call `uses: ukncsc/scaffold/.github/workflows/<x>.yml@v1`; Dependabot bumps the pin.

### Self-install (no App, no PAT)

1. Repo admin copies the thin caller `.github/workflows/scaffold.yml` and `.github/scaffold.yml` from `templates/` (later: org starter workflow).
2. Admin follows the `INSTALL.md` checklist: labels (or run the `scaffold-labels` job), ruleset (PRs only, code-owner review, required SCAFFOLD checks, no bypass), CODEOWNERS block, Copilot settings (section 6), secret scanning + push protection.
3. A `scaffold-sync` job in the target repo opens a PR (via `GITHUB_TOKEN`) to add/update Copilot instruction files, `.github/skills/`, templates and `.scaffold-version`. Workflow files are never touched by automation.
4. Requires org setting "Allow GitHub Actions to create and approve pull requests". PRs opened by `GITHUB_TOKEN` don't trigger workflows; a human re-runs checks on them.

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
- **Circuit breaker:** 4 consecutive or 6 total rework rounds → `scaffold:escalate`.
- Copilot firewall on the default allowlist; human approval required for workflow runs on Copilot PRs.

### Handover gates

Every handover between a human, an agent or a stage is a gate. Gates are **protected** (only the right actor can pass them), **deterministic** (Actions code decides, not a model) and **monitor-able** (every pass or fail is recorded).

| Gate | Passed by | Protection | Evidence |
| --- | --- | --- | --- |
| Triaged → ready | `triage` Action applies `scaffold:ready` | Members-only trigger; schema-validated output | Audit log, issue label |
| Ready → planned | Member comments `/plan` | `author_association` check | Plan comment, audit log |
| Planned → approved | Developer applies `scaffold:plan-approved` | Plan gate reads the issue timeline: label must be applied by a listed approver in `scaffold.yml` (not the issue author or a bot), and the plan comment must be unchanged since approval (hash) | Timeline event, check run |
| Approved → implementing | Developer assigns issue to Copilot | Plan gate on the resulting PR | Copilot PR |
| PR → mergeable | Required checks + code-owner review | Ruleset, no bypass | Check runs, review |

- Labels alone are not protection: anyone with triage permission can apply them. The check that reads the timeline is the protection.
- Each issue has one SCAFFOLD **status comment**, updated in place, showing passed and pending gates (as a Mermaid diagram, section 10).

## 7. Operations

- **Kill switch:** org/repo variable `SCAFFOLD_ENABLED=false` skips all AI steps.
- **Rate guards:** concurrency group per issue/PR, input size cap, GitHub Models 429 → backoff then neutral check + comment (never a failure).
- **Audit log:** per AI step, record skill, version, model, input hash and validated output to the job summary and a 90-day artifact. Prompt bodies are not logged.
- **Usage report:** weekly scheduled job posts runs per skill and repo to an issue (pilot metrics: cost, false positives).

## 8. Humans in the loop

Humans are the slow part of the workflow; agents are not. SCAFFOLD is designed to spend human time and attention only where a decision is needed.

**Assumption (v1):** up to 6 developers per project and no other humans in the loop. Non-developer roles are deferred (below).

- **One prioritised queue:** a GitHub Projects board per project with `Status` (mirrors the gates in section 6), `Priority`, `Size` and `Iteration` fields. Developers pull from the top of `Ready`; they don't choose from the full backlog.
  - `GITHUB_TOKEN` can't write to Projects, so SCAFFOLD only sets labels; the board uses Projects' built-in workflows (auto-add by label, set status on close/merge).
- **Flow lead:** a rotating developer (weekly) orders the backlog, runs `/plan` on the next items and watches `scaffold:escalate`.
- **Work-in-progress limits:** `scaffold.yml` sets a maximum number of open Copilot PRs per developer (default 2). Going over gets a comment, not a block.
- **Review routing:** CODEOWNERS plus team auto-assignment (round robin) so no PR waits without a reviewer.
- **Low-noise output:** SCAFFOLD updates one status comment per issue or PR rather than posting new comments, and only @-mentions a human when a gate needs them.

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
- **Hand-maintained** (`docs/diagrams/`): `workflow.md` (lifecycle and gates) and `architecture.md`. These are the canonical pictures.
- **Generated:** an Action renders the label state machine from `labels.yml` and the workflow graph from `.github/workflows/*.yml`. A check fails if a generated diagram is stale (as with `dist/`).
- **Per issue:** the status comment (section 6) shows the issue's position in the workflow as a Mermaid diagram.
- **Diagrams as input:** a PR that changes `docs/diagrams/workflow.md` is a proposal to change the workflow; once merged, the implementing work follows from it.
- **Later:** a `diagram-to-mermaid` skill turning sketches or whiteboard photos attached to issues into a Mermaid draft for a human to correct. Depends on GitHub Models image input and reading issue attachments with `GITHUB_TOKEN` (confirm in Phase 0).

## 11. Plan

The workflow is built in **vertical slices**: each slice adds one stage end to end, runs it on real issues, and ends with a retrospective that updates this plan. The workflow is expected to change as we learn how it flows and how people work with it. Each slice also lists what it teaches about GitHub Actions and Issues.

### Phase 0: Scope and governance

- Confirm with `ukncsc` admins: hosting (Enterprise Cloud vs GHE.com vs GHES), GitHub Models enabled (including image input), Copilot coding agent enabled with OpenAI models, org Actions settings.
- Choose OpenAI model IDs for `fast`, `standard`, `deep`.
- Agree the data-handling rule with security and data owners (e.g. opt-in per repo, classification limits, logging position).
- Confirm the source-of-truth split and the Jira route (section 9), including whether "GitHub for Jira" is allowed.
- Choose the pilot repos and the 6 developers; agree the flow lead rota and work-in-progress limits (section 8).
- Draw the current workflow and target lifecycle in `docs/diagrams/workflow.md`.
- Confirm the human approval points in section 2.

### Phase 1: Foundations

Only what slice 1 needs.

- Scaffold the layout (section 5); port Hospital's TS libs, tests and self-test workflow.
- Write `CHARTER.md`, `labels.yml`, `scaffold.yml` schema and config-guard.
- Add kill switch, rate guards and audit logging.
- Add CODEOWNERS, branch and `v*` tag rulesets, semver releases.
- Create `scaffold-sandbox` with fixture issues and PRs, including prompt-injection cases; it is the end-to-end test for every slice.

### Phase 2: Vertical slices

Each slice: build → run in the sandbox → run on the pilot repo → retrospective → PR to this plan.

| Slice | Adds | Learn |
| --- | --- | --- |
| 1. Intake | Jira issue form, `triage`, labels, Projects board, status comment | Issue forms, labels, Projects; workflow triggers, `permissions:`, `GITHUB_TOKEN`, job summaries |
| 2. Plan | `/plan`, `task-decomposer`, protected plan gate | `issue_comment` events, reusable workflows, composite actions, required checks, rulesets |
| 3. Implement | Copilot assignment, `tdd`/`implement` skills, protected paths, test integrity, circuit breaker, work-in-progress limits | Copilot coding agent, CODEOWNERS, `pull_request` events |
| 4. Review | `code-review`, `ci-diagnose` | `pull_request` vs `pull_request_target` security, `workflow_run` |
| 5. Visibility | Generated diagrams, freshness check, weekly usage report | `schedule`, artifacts, `workflow_dispatch` |

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
- **Platform availability:** GitHub Models or Copilot OpenAI models may not be enabled for `ukncsc`; Phase 0 blocks on confirmation.
- **Rate limits and cost:** tiers, rate guards, kill switch, usage report.
- **Non-deterministic output:** schema validation; invalid output never writes.
- **`GITHUB_TOKEN` limits:** sync PRs don't trigger workflows; workflow files and rulesets need a human admin.
- **Skill drift:** pinned versions, Dependabot, `.scaffold-version`.
- **Data handling:** unresolved until Phase 0.
- **Human bottleneck:** review queues grow faster than developers can clear them; work-in-progress limits, one prioritised queue and per-gate metrics (sections 8 and 11).
- **Two sources of truth:** Jira and `docs/spec/` drift; agreed split and Jira keys on every issue and PR (section 9).

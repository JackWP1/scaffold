# SCAFFOLD: Agentic Workflow on GitHub

**S**ecure, **C**ompliant **A**gentic **F**ramework **F**or **O**rchestrated **L**ifecycle **D**elivery: a reusable, versioned set of GitHub Actions and skills that assist humans across the issue → PR lifecycle, using only GitHub automation and OpenAI models. It adapts the governance and tooling of [Hospital](../hospital-workflow) to these constraints.

## 1. Constraints

| Constraint | Consequence |
| --- | --- |
| GitHub automation only: Actions, native features (rulesets, CODEOWNERS, environments, labels, issue forms) and Copilot agents | No external services, gateways or MCP servers; no self-hosted infrastructure |
| OpenAI models only | Actions call OpenAI models via GitHub Models; the Copilot coding agent is set to an OpenAI model |
| No GitHub App, no PAT | Jobs use `GITHUB_TOKEN` only: no cross-repo writes, no edits to `.github/workflows/`, no ruleset creation. Installs are self-service (§5) |
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
| `schedule` (weekly) | — | Usage report issue (§7) |

### Issue lifecycle

1. Issue opened → `triage` (members only, §6) → `scaffold:triage` / `scaffold:needs-info` / `scaffold:ready`.
2. Member comments `/plan` → plan comment.
3. Human reviews plan → applies `scaffold:plan-approved`.
4. Human assigns issue to Copilot → Copilot opens PR.
5. Guard checks (§6) + `code-review` → human review → human merge.
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
| `hospital:*` state labels | Simplified `scaffold:*` labels (§2) |
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
src/ tests/ dist/       TypeScript glue, tests, bundled output
```

- Skills and prompts ship **inside composite actions**, so the runner fetches them at the pinned ref; no cross-repo checkout token needed.
- Consumers call `uses: ukncsc/scaffold/.github/workflows/<x>.yml@v1`; Dependabot bumps the pin.

### Self-install (no App, no PAT)

1. Repo admin copies the thin caller `.github/workflows/scaffold.yml` and `.github/scaffold.yml` from `templates/` (later: org starter workflow).
2. Admin follows the `INSTALL.md` checklist: labels (or run the `scaffold-labels` job), ruleset (PRs only, code-owner review, required SCAFFOLD checks, no bypass), CODEOWNERS block, Copilot settings (§6), secret scanning + push protection.
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

## 7. Operations

- **Kill switch:** org/repo variable `SCAFFOLD_ENABLED=false` skips all AI steps.
- **Rate guards:** concurrency group per issue/PR, input size cap, GitHub Models 429 → backoff then neutral check + comment (never a failure).
- **Audit log:** per AI step, record skill, version, model, input hash and validated output to the job summary and a 90-day artifact. Prompt bodies are not logged.
- **Usage report:** weekly scheduled job posts runs per skill and repo to an issue (pilot metrics: cost, false positives).

## 8. Plan

### Phase 0: Scope and governance

- Confirm with `ukncsc` admins: hosting (Enterprise Cloud vs GHE.com vs GHES), GitHub Models enabled, Copilot coding agent enabled with OpenAI models, org Actions settings.
- Choose OpenAI model IDs for `fast`, `standard`, `deep`.
- Agree the data-handling rule with security and data owners (e.g. opt-in per repo, classification limits, logging position).
- Choose the pilot repos.
- Confirm the human approval points in §2.

### Phase 1: Central repo

- Scaffold the layout (§5); port Hospital's TS libs, tests and self-test workflow.
- Write `CHARTER.md`, `labels.yml`, `recommendations.yml`, `scaffold.yml` schema and config-guard.
- Write reusable workflows and composite actions: `triage`, `plan`, `pr-review`, `ci-diagnose`, guard checks (plan gate, protected paths, test integrity).
- Adapt the six skills, `manifest.yml`, `models.yml` and output schemas; add skill tests.
- Add kill switch, rate guards and audit logging.
- Add CODEOWNERS, branch and `v*` tag rulesets, semver releases.

### Phase 2: Install path

- Write `templates/` (caller, `scaffold.yml`, Copilot instructions, issue/PR templates, CODEOWNERS snippet).
- Write `INSTALL.md` checklist and the `scaffold-labels` and `scaffold-sync` jobs.
- Move to `ukncsc/scaffold` (internal) and set Actions access.

### Phase 3: Pilot

- Create `ukncsc/scaffold-sandbox` with fixture issues and PRs, including prompt-injection cases; use it as the end-to-end test.
- Install on the Phase 0 pilot repo(s).
- Run the weekly usage report; tune skills, tiers and guardrails; measure review quality, false positives and cost.

### Phase 4: Upgrade path

- Dependabot for `@vN` pins; `scaffold-sync` PRs for non-workflow files, reporting locally edited files rather than overwriting.
- Write docs and `CONTRIBUTING-SKILLS.md`.

### Phase 5: Org-level starter workflow

- Publish the thin caller as `ukncsc/.github/workflow-templates/scaffold.yml` with its properties file.
- Keep reusable workflows and skills in `ukncsc/scaffold`.
- Optionally enforce via org rulesets (required SCAFFOLD checks) once the pilot is stable.

## 9. Risks

- **Prompt injection:** members-only triggers, untrusted-input handling, single-shot JSON outputs, no code-writing outside Copilot.
- **Platform availability:** GitHub Models or Copilot OpenAI models may not be enabled for `ukncsc`; Phase 0 blocks on confirmation.
- **Rate limits and cost:** tiers, rate guards, kill switch, usage report.
- **Non-deterministic output:** schema validation; invalid output never writes.
- **`GITHUB_TOKEN` limits:** sync PRs don't trigger workflows; workflow files and rulesets need a human admin.
- **Skill drift:** pinned versions, Dependabot, `.scaffold-version`.
- **Data handling:** unresolved until Phase 0.

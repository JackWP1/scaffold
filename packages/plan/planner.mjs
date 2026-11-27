// task-decomposer for an issue the admit job admitted (PLAN.md section 2, slice 2), with the client and
// model injected so tests can fake them.
import { createHash } from 'node:crypto';
import { validate } from '../core/lib/validate.mjs';
import { wrapUntrusted } from '../core/lib/text.mjs';
import { RateLimited } from '../core/lib/models.mjs';
import { readRepoFile, stageOn } from '../core/lib/config.mjs';
import { scenariosRequired, checkScenarios, scenarioComments } from '../core/lib/scenarios.mjs';
import { scenariosText } from '../core/lib/gherkin.mjs';
import { issueSteps } from '../core/lib/issue.mjs';
import { MARKER, setGates, manualStates } from '../core/lib/status.mjs';
import { PLAN_MARKER, checkPlan, isTooBig } from './rules.mjs';
import { renderPlan, splitSummary } from './render.mjs';

const MAX_PATHS = 1500;
const heading = '### SCAFFOLD plan';

// Returns the job summary (markdown). The admit job chose `issueNumber` and `commentId`, which may come
// from its sweep rather than this event. `config` is null when `configError` is set.
export async function runPlan(gh, repo, { event, issueNumber, commentId, config, configError, loadSkill, callModel }) {
  const issue = await gh.get(`/repos/${repo}/issues/${issueNumber}`);
  const comment = await gh.get(`/repos/${repo}/issues/comments/${commentId}`);
  const labels = issue.labels.map((l) => l.name);
  const { setLabels, findComment, findComments, upsertComment, upsertStatus, events } = issueSteps(gh, repo, issue.number, labels);
  const others = config ? manualStates(config) : {};
  const updateStatus = async (states, next) => upsertStatus(setGates((await findComment(MARKER))?.body, { ...others, ...states }, next));

  // On failure, a first plan gives back its in-flight slot. A replan keeps scaffold:planned and the old plan,
  // with the approval withdrawn; labels are set either way, since a gate run may have changed them meanwhile.
  async function failed(plan, why, next = 'comment `/plan` again to retry.') {
    if (await findComment(PLAN_MARKER)) {
      await setLabels(['scaffold:planned'], ['scaffold:ready', 'scaffold:plan-approved']);
      await updateStatus({ Plan: `⚠️ ${plan}`, Approval: '⏳ withdrawn by `/plan`' }, next);
    } else {
      await setLabels(['scaffold:ready'], ['scaffold:planned', 'scaffold:plan-approved']);
      await updateStatus({ Plan: `⚠️ ${plan}` }, next);
    }
    return `${heading}\n${why}`;
  }

  async function repoPaths() {
    try {
      const { tree } = await gh.get(`/repos/${repo}/git/trees/${encodeURIComponent(event.repository.default_branch)}?recursive=1`);
      return tree.filter((t) => t.type === 'blob').slice(0, MAX_PATHS).map((t) => t.path).join('\n');
    } catch (err) {
      console.warn(err.message);
      return '(unavailable)';
    }
  }

  if (configError) {
    return failed('`.github/scaffold-config.yml` is invalid', `Invalid config: ${configError}`, 'fix `.github/scaffold-config.yml`, then comment `/plan` again.');
  }
  if ((await findComments(PLAN_MARKER)).length > 1) {
    return failed('more than one comment is marked as the plan', 'More than one plan comment (no writes)', 'delete the extra plan comment, then comment `/plan` again.');
  }
  // Re-checked here as well as at admission: the scenarios may have changed since (PLAN.md section 5).
  let scenarios = null;
  if (scenariosRequired(config, labels)) {
    scenarios = checkScenarios({
      events: await events(), issue: issue.number, author: issue.user?.login, approvers: config.approvers, comments: await scenarioComments(gh, repo, issue.number),
    });
    if (!scenarios.ok) {
      return failed(`the scenarios aren't approved: ${scenarios.reason}`, `Scenarios not approved: ${scenarios.reason}`, 'a listed approver approves the scenarios (`scaffold:gherkin-approved`), then a member comments `/plan` again.');
    }
  }
  const { system, schema, version: skillVersion, model } = await loadSkill();
  const status = await findComment(MARKER);
  const precedents = await readRepoFile(gh, repo, 'PRECEDENTS.md');
  const limits = config.pr_size;
  const maxStack = config.max_stack_prs;
  const user = [
    'Plan this issue.',
    `Size limits: soft ${limits.soft.files} files / ${limits.soft.lines} lines; hard ${limits.hard.files} files / ${limits.hard.lines} lines. Exempt files: ${limits.exempt.join(', ')}. Stack limit: at most ${maxStack} PRs.`,
    wrapUntrusted('untrusted_issue', `Title: ${issue.title}\n\n${issue.body ?? ''}`),
    wrapUntrusted('untrusted_triage', status?.body.replace(MARKER, '') ?? '(none)'),
    scenarios ? `Approved scenarios: ${scenarios.ids.join(', ')}. Map every one to the sub-task that makes it pass.` : '',
    scenarios ? wrapUntrusted('untrusted_scenarios', scenariosText(scenarios.comment.body)) : '',
    wrapUntrusted('untrusted_plan_comment', comment.body.replace(/^\/plan\s*/, '') || '(none)'),
    precedents ? wrapUntrusted('untrusted_precedents', precedents) : '',
    wrapUntrusted('untrusted_repo_paths', await repoPaths()),
  ].filter(Boolean).join('\n\n');
  const inputHash = createHash('sha256').update(user).digest('hex').slice(0, 16);

  // One retry when the plan breaks the size rules: the diagram's "split" step (docs/diagrams/workflow.md).
  let plan;
  let problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? user : `${user}\n\nYour previous plan broke these rules; fix them:\n${problems.map((p) => `- ${p}`).join('\n')}`;
    let out;
    try {
      out = await callModel({ model, system, user: prompt, schema });
    } catch (err) {
      if (plan) break;
      const why = err instanceof RateLimited ? 'Copilot is rate limiting' : 'the model call failed';
      console.warn(err.message);
      return failed(`skipped: ${why}`, `Skipped: ${why}\n\n\`${err.message.slice(0, 500)}\``);
    }
    const errors = validate(schema, out);
    if (errors.length) {
      console.log(`::warning::Invalid plan output: ${errors.join('; ')}`);
      if (plan) break;
      return failed('invalid output, nothing applied', `Invalid output (no writes):\n\n- ${errors.join('\n- ')}`);
    }
    plan = out;
    problems = checkPlan(plan, limits, maxStack, scenarios?.ids ?? []);
    if (!problems.length || plan.split === 'too-big') break;
  }

  const tooBig = isTooBig(plan, maxStack);
  const planComment = await upsertComment(PLAN_MARKER, renderPlan(plan, { problems, skillVersion, model, limits, maxStack, tooBig, scenariosHash: scenarios?.hash }));
  const auditRow = (outcome) => [
    heading,
    '| Skill | Version | Model | Input hash | Split | Estimate | Problems | Outcome |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    `| task-decomposer | ${skillVersion} | ${model} | \`${inputHash}\` | ${plan.split} | ${plan.estimate.files} files / ${plan.estimate.lines} lines | ${problems.length} | ${outcome} |`,
    '',
    '<details><summary>Validated output</summary>',
    '',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
    '</details>',
  ].join('\n');

  // Too big for one stack: leaves flight and goes back to triage for smaller tickets (PLAN.md section 6).
  if (tooBig) {
    await setLabels(['scaffold:too-big'], ['scaffold:planned', 'scaffold:ready', 'scaffold:plan-approved']);
    await updateStatus(
      { Plan: `🧱 [too big](${planComment.html_url}): needs more than ${maxStack} PRs, back to triage`, Approval: '⏳ pending' },
      stageOn(config, 'intake')
        ? 'a member applies `scaffold:triage` to get smaller tickets proposed, or narrows the issue first.'
        : 'split it into smaller tickets by hand: see `packages/intake/HANDOFF.md`.',
    );
    return auditRow('too big: back to triage');
  }

  // Admission already applied these; set again in case a gate run on this issue changed them meanwhile.
  await setLabels(['scaffold:planned'], ['scaffold:ready', 'scaffold:plan-approved']);
  const link = `[planned](${planComment.html_url})`;
  const approvers = config.approvers.map((a) => `\`${a}\``).join(', ');
  await updateStatus(
    {
      Plan: problems.length ? `⚠️ ${link} with problems` : `📝 ${link}: ${plan.estimate.files} files / ${plan.estimate.lines} lines, ${splitSummary(plan)}`,
      Approval: problems.length ? '⛔ can\'t be approved as it stands' : '⏳ waiting for a listed approver',
    },
    problems.length
      ? 'comment `/plan` with guidance to replan, or split the work into separate issues.'
      : approvers
        ? `a listed approver (${approvers}) reviews the plan and applies \`scaffold:plan-approved\`.`
        : 'no approvers are listed: add them to `.github/scaffold-config.yml`.',
  );
  return auditRow(problems.length ? 'planned with problems' : 'planned');
}

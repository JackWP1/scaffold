// Entry point for the plan composite action: `/plan` → task-decomposer (PLAN.md section 2, slice 2).
import { readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { github } from '../lib/github.mjs';
import { callModel, RateLimited } from '../lib/models.mjs';
import { validate } from '../lib/validate.mjs';
import { wrapUntrusted } from '../lib/text.mjs';
import { loadSkill } from '../lib/skills.mjs';
import { loadConfig, readRepoFile } from '../lib/config.mjs';
import { issueSteps } from '../lib/issue.mjs';
import { MARKER, setGates } from '../lib/status.mjs';
import { PLAN_MARKER, checkPlan } from './rules.mjs';
import { renderPlan, splitSummary } from './render.mjs';

const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const PLANNABLE = ['scaffold:ready', 'scaffold:planned', 'scaffold:plan-approved'];
const IN_FLIGHT = ['scaffold:planned', 'scaffold:plan-approved'];
const MAX_PATHS = 1500;

const root = process.env.SCAFFOLD_ROOT;
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const gh = github(token);
const summary = (md) => appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${md}\n`);

const { issue, comment } = event;
const labels = issue.labels.map((l) => l.name);
const { setLabels, findComment, upsertComment, upsertStatus } = issueSteps(gh, repo, issue.number, labels);
const react = (content) => gh.post(`/repos/${repo}/issues/comments/${comment.id}/reactions`, { content }).catch((err) => console.warn(err.message));

function skip(reason) {
  console.log(`Skipping: ${reason}`);
  return summary(`### SCAFFOLD plan\nSkipped: ${reason}`);
}

async function updateStatus(states, next) {
  const status = await findComment(MARKER);
  await upsertStatus(setGates(status?.body, states, next));
}

// Open issues in flight (PLAN.md section 8), not counting this one. Sub-tickets carry no lifecycle label.
async function inFlight() {
  const numbers = new Set();
  for (const label of IN_FLIGHT) {
    for await (const page of gh.pages(`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`)) {
      for (const i of page) if (!i.pull_request && i.number !== issue.number) numbers.add(i.number);
    }
  }
  return numbers.size;
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

async function main() {
  if (issue.pull_request) return skip('pull request');
  if (!/^\/plan(\s|$)/.test(comment.body ?? '')) return skip('comment is not /plan');
  if (!TRUSTED.includes(comment.author_association) || comment.user?.type !== 'User') {
    await react('confused');
    return skip(`/plan by ${comment.author_association} ${comment.user?.type}: members only`);
  }
  if (!labels.some((l) => PLANNABLE.includes(l))) {
    await react('confused');
    return skip('issue is not scaffold:ready');
  }

  const config = await loadConfig(gh, repo);
  const count = await inFlight();
  if (count >= config.max_in_flight) {
    await react('confused');
    await updateStatus(
      { Plan: `⏸️ waiting: ${count} of ${config.max_in_flight} tickets in flight` },
      'wait for a ticket to merge or close, then comment `/plan` again.',
    );
    return summary(`### SCAFFOLD plan\nRefused: ${count} of ${config.max_in_flight} tickets in flight`);
  }
  await react('eyes');

  // A new plan withdraws any approval of the old one.
  await setLabels([], ['scaffold:plan-approved']);

  const { system, schema, version: skillVersion, model } = await loadSkill(root, 'task-decomposer', process.env.SCAFFOLD_MODEL);
  const status = await findComment(MARKER);
  const precedents = await readRepoFile(gh, repo, 'PRECEDENTS.md');
  const limits = config.pr_size;
  const user = [
    'Plan this issue.',
    `Size limits: soft ${limits.soft.files} files / ${limits.soft.lines} lines; hard ${limits.hard.files} files / ${limits.hard.lines} lines. Exempt files: ${limits.exempt.join(', ')}.`,
    wrapUntrusted('untrusted_issue', `Title: ${issue.title}\n\n${issue.body ?? ''}`),
    wrapUntrusted('untrusted_triage', status?.body.replace(MARKER, '') ?? '(none)'),
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
      out = await callModel({ token, model, system, user: prompt, schema });
    } catch (err) {
      if (plan) break;
      const why = err instanceof RateLimited ? 'Copilot is rate limiting' : 'the model call failed';
      console.warn(err.message);
      await updateStatus({ Plan: `⚠️ skipped: ${why}` }, 'comment `/plan` again to retry.');
      return summary(`### SCAFFOLD plan\nSkipped: ${why}\n\n\`${err.message.slice(0, 500)}\``);
    }
    const errors = validate(schema, out);
    if (errors.length) {
      console.log(`::warning::Invalid plan output: ${errors.join('; ')}`);
      if (plan) break;
      await updateStatus({ Plan: '⚠️ invalid output, nothing applied' }, 'comment `/plan` again to retry.');
      return summary(`### SCAFFOLD plan\nInvalid output (no writes):\n\n- ${errors.join('\n- ')}`);
    }
    plan = out;
    problems = checkPlan(plan, limits);
    if (!problems.length || plan.split === 'too-big') break;
  }

  const planComment = await upsertComment(PLAN_MARKER, renderPlan(plan, { problems, skillVersion, model, limits }));
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

  await summary([
    '### SCAFFOLD plan',
    '| Skill | Version | Model | Input hash | Split | Estimate | Problems |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| task-decomposer | ${skillVersion} | ${model} | \`${inputHash}\` | ${plan.split} | ${plan.estimate.files} files / ${plan.estimate.lines} lines | ${problems.length} |`,
    '',
    `In flight before this plan: ${count} of ${config.max_in_flight}`,
    '',
    '<details><summary>Validated output</summary>',
    '',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
    '</details>',
  ].join('\n'));
}

await main();

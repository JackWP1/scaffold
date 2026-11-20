// Entry point for the plan action's plan mode: task-decomposer for an issue the admit job admitted (PLAN.md section 2, slice 2).
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

const MAX_PATHS = 1500;

const root = process.env.SCAFFOLD_ROOT;
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const gh = github(token);
const summary = (md) => appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${md}\n`);

// The admit job chose this issue and comment, which may come from its sweep rather than this event.
const issue = await gh.get(`/repos/${repo}/issues/${Number(process.env.SCAFFOLD_ISSUE)}`);
const comment = await gh.get(`/repos/${repo}/issues/comments/${Number(process.env.SCAFFOLD_COMMENT)}`);
const labels = issue.labels.map((l) => l.name);
const { setLabels, findComment, upsertComment, upsertStatus } = issueSteps(gh, repo, issue.number, labels);

async function updateStatus(states, next) {
  const status = await findComment(MARKER);
  await upsertStatus(setGates(status?.body, states, next));
}

// On failure, a first plan gives back its in-flight slot; a replan keeps scaffold:planned and the old plan.
async function failed(plan, why) {
  if (!(await findComment(PLAN_MARKER))) await setLabels(['scaffold:ready'], ['scaffold:planned']);
  await updateStatus({ Plan: `⚠️ ${plan}` }, 'comment `/plan` again to retry.');
  return summary(`### SCAFFOLD plan\n${why}`);
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
  const config = await loadConfig(gh, repo);
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
      return failed(`skipped: ${why}`, `Skipped: ${why}\n\n\`${err.message.slice(0, 500)}\``);
    }
    const errors = validate(schema, out);
    if (errors.length) {
      console.log(`::warning::Invalid plan output: ${errors.join('; ')}`);
      if (plan) break;
      return failed('invalid output, nothing applied', `Invalid output (no writes):\n\n- ${errors.join('\n- ')}`);
    }
    plan = out;
    problems = checkPlan(plan, limits);
    if (!problems.length || plan.split === 'too-big') break;
  }

  const planComment = await upsertComment(PLAN_MARKER, renderPlan(plan, { problems, skillVersion, model, limits }));
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

  await summary([
    '### SCAFFOLD plan',
    '| Skill | Version | Model | Input hash | Split | Estimate | Problems |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| task-decomposer | ${skillVersion} | ${model} | \`${inputHash}\` | ${plan.split} | ${plan.estimate.files} files / ${plan.estimate.lines} lines | ${problems.length} |`,
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

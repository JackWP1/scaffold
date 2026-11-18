// Entry point for the plan gate composite action: planned → approved (PLAN.md section 6, slice 2).
// Runs when scaffold:plan-approved is applied and when someone edits the plan comment. No model call.
import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { github } from '../lib/github.mjs';
import { loadConfig } from '../lib/config.mjs';
import { issueSteps } from '../lib/issue.mjs';
import { MARKER, setGates } from '../lib/status.mjs';
import { PLAN_MARKER, decodePlan, evaluateApproval } from '../plan/rules.mjs';
import { createSubTickets } from '../plan/subtickets.mjs';

const root = process.env.SCAFFOLD_ROOT;
const repo = process.env.GITHUB_REPOSITORY;
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const gh = github(process.env.GITHUB_TOKEN);
const summary = (md) => appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${md}\n`);

const { issue } = event;
const labels = issue.labels.map((l) => l.name);
const { setLabels, findComment, upsertStatus, events } = issueSteps(gh, repo, issue.number, labels);

function skip(reason) {
  console.log(`Skipping: ${reason}`);
  return summary(`### SCAFFOLD plan gate\nSkipped: ${reason}`);
}

async function updateStatus(states, next) {
  const status = await findComment(MARKER);
  await upsertStatus(setGates(status?.body, states, next));
}

const hours = (from, to) => ((Date.parse(to) - Date.parse(from)) / 3_600_000).toFixed(1);

async function main() {
  if (issue.pull_request) return skip('pull request');
  if (event.action === 'labeled' && event.label?.name !== 'scaffold:plan-approved') return skip('label is not scaffold:plan-approved');
  if (event.action === 'edited' && !event.comment?.body?.startsWith(PLAN_MARKER)) return skip('edited comment is not the plan');
  if (!labels.includes('scaffold:plan-approved')) return skip('scaffold:plan-approved is not applied');

  const schema = JSON.parse(await readFile(join(root, 'schemas/plan.schema.json'), 'utf8'));
  const config = await loadConfig(gh, repo);
  const planComment = await findComment(PLAN_MARKER);
  const plan = decodePlan(planComment?.body, schema);
  const result = evaluateApproval({
    events: await events(),
    author: issue.user?.login,
    approvers: config.approvers,
    planComment,
    plan,
    limits: config.pr_size,
  });
  const audit = (outcome, extra = []) => summary([
    '### SCAFFOLD plan gate',
    '| Gate | Outcome | Applied by | Plan hash | Hours from plan to approval |',
    '| --- | --- | --- | --- | --- |',
    `| Planned → approved | ${outcome} | ${result.approver ?? '-'} | ${result.hash ? `\`${result.hash}\`` : '-'} | ${planComment && result.at ? hours(planComment.updated_at, result.at) : '-'} |`,
    ...extra,
  ].join('\n'));

  if (!result.ok) {
    await setLabels(planComment ? ['scaffold:planned'] : [], ['scaffold:plan-approved']);
    await updateStatus({ Approval: `❌ not approved: ${result.reason}` }, 'a listed approver applies `scaffold:plan-approved` once the problem is fixed.');
    return audit(`fail: ${result.reason}`);
  }

  await setLabels([], ['scaffold:planned']);
  const states = { Approval: `✅ approved by \`${result.approver}\` (plan \`${result.hash}\`)` };
  const extra = [];
  if (plan.split === 'sub-tickets') {
    try {
      const { numbers } = await createSubTickets(gh, repo, issue, plan, labels);
      states.Plan = `📝 [planned](${planComment.html_url}): sub-tickets ${Object.values(numbers).map((n) => `#${n}`).join(', ')}`;
      extra.push('', `Sub-tickets: ${Object.values(numbers).map((n) => `#${n}`).join(', ')}`);
    } catch (err) {
      console.log(`::warning::Sub-tickets not created: ${err.message}`);
      states.Plan = `⚠️ [planned](${planComment.html_url}): sub-tickets could not be created; create them from the plan by hand`;
      extra.push('', `Sub-tickets not created: \`${err.message.slice(0, 300)}\``);
    }
  }
  await updateStatus(states, plan.split === 'sub-tickets'
    ? 'developers assign each sub-ticket to Copilot when its blockers are done (coming in slice 3).'
    : 'a developer assigns this issue to Copilot (coming in slice 3).');
  return audit('pass', extra);
}

await main();

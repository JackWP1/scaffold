// The planned → approved gate (PLAN.md section 6, slice 2), with the client injected so tests can fake it.
// Runs when scaffold:plan-approved is applied and when someone edits or deletes the plan comment. No model call.
import { issueSteps } from '../lib/issue.mjs';
import { MARKER, setGates } from '../lib/status.mjs';
import { PLAN_MARKER, decodePlan, evaluateApproval } from './rules.mjs';
import { createSubTickets } from './subtickets.mjs';

const hours = (from, to) => ((Date.parse(to) - Date.parse(from)) / 3_600_000).toFixed(1);

// Returns the job summary lines, or a skip reason.
export async function runGate(gh, repo, { event, schema, config }) {
  const { issue } = event;
  const labels = issue.labels.map((l) => l.name);
  const { setLabels, findComment, upsertStatus, events } = issueSteps(gh, repo, issue.number, labels);
  const updateStatus = async (states, next) => upsertStatus(setGates((await findComment(MARKER))?.body, states, next));

  if (issue.pull_request) return { skip: 'pull request' };
  if (event.action === 'labeled' && event.label?.name !== 'scaffold:plan-approved') return { skip: 'label is not scaffold:plan-approved' };
  if (['edited', 'deleted'].includes(event.action) && !event.comment?.body?.startsWith(PLAN_MARKER)) return { skip: 'comment is not the plan' };

  const planComment = await findComment(PLAN_MARKER);
  // No plan left: back to Ready, which also frees the in-flight slot (PLAN.md section 8).
  if (!planComment && (event.action === 'deleted' || labels.includes('scaffold:plan-approved'))) {
    await setLabels(['scaffold:ready'], ['scaffold:planned', 'scaffold:plan-approved']);
    const what = event.action === 'deleted' ? 'plan deleted' : 'no plan';
    await updateStatus({ Plan: `🗑️ ${what}`, Approval: '⏳ pending' }, 'a member comments `/plan` to plan again.');
    return { lines: ['### SCAFFOLD plan gate', `${what[0].toUpperCase()}${what.slice(1)}: approval withdrawn, back to \`scaffold:ready\``] };
  }
  if (!labels.includes('scaffold:plan-approved')) return { skip: 'scaffold:plan-approved is not applied' };

  const plan = decodePlan(planComment.body, schema);
  const result = evaluateApproval({
    events: await events(),
    author: issue.user?.login,
    approvers: config.approvers,
    planComment,
    plan,
    limits: config.pr_size,
  });
  const audit = (outcome, extra = []) => ({
    lines: [
      '### SCAFFOLD plan gate',
      '| Gate | Outcome | Applied by | Plan hash | Hours from plan to approval |',
      '| --- | --- | --- | --- | --- |',
      `| Planned → approved | ${outcome} | ${result.approver ?? '-'} | ${result.hash ? `\`${result.hash}\`` : '-'} | ${result.at ? hours(planComment.updated_at, result.at) : '-'} |`,
      ...extra,
    ],
  });
  const reject = async (reason, extra) => {
    await setLabels(['scaffold:planned'], ['scaffold:plan-approved']);
    await updateStatus({ Approval: `❌ not approved: ${reason}` }, 'a listed approver applies `scaffold:plan-approved` again once the problem is fixed.');
    return audit(`fail: ${reason}`, extra);
  };

  if (!result.ok) return reject(result.reason);

  // Approval stands only once every sub-ticket exists; a retry reuses the ones already created.
  const states = { Approval: `✅ approved by \`${result.approver}\` (plan \`${result.hash}\`)` };
  const extra = [];
  if (plan.split === 'sub-tickets') {
    try {
      const refs = Object.values((await createSubTickets(gh, repo, issue, plan, labels)).numbers).map((n) => `#${n}`).join(', ');
      states.Plan = `📝 [planned](${planComment.html_url}): sub-tickets ${refs}`;
      extra.push('', `Sub-tickets: ${refs}`);
    } catch (err) {
      console.log(`::warning::Sub-tickets not created: ${err.message}`);
      return reject('sub-tickets could not all be created', ['', `Sub-tickets not created: \`${err.message.slice(0, 300)}\``]);
    }
  }
  await setLabels([], ['scaffold:planned']);
  await updateStatus(states, plan.split === 'sub-tickets'
    ? 'developers assign each sub-ticket to Copilot when its blockers are done (coming in slice 3).'
    : 'a developer assigns this issue to Copilot (coming in slice 3).');
  return audit('pass', extra);
}

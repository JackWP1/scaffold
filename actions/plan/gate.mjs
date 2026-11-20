// The planned → approved gate (PLAN.md section 6, slice 2), with the client injected so tests can fake it.
// Runs when scaffold:plan-approved is applied and when any bot comment is edited or deleted. No model call.
//
// `/plan` admission runs in a different concurrency group, so it can change this issue while the gate
// runs. The gate reads the issue fresh, and after writing checks whether an admission came after the
// approval it checked. The plan job shares this gate's per-issue group and sets the labels last.
import { issueSteps } from '../lib/issue.mjs';
import { MARKER, setGates } from '../lib/status.mjs';
import { escapeForComment } from '../lib/text.mjs';
import { PLAN_MARKER, decodePlan, evaluateApproval } from './rules.mjs';
import { createSubTickets } from './subtickets.mjs';

const hours = (from, to) => ((Date.parse(to) - Date.parse(from)) / 3_600_000).toFixed(1);

// An admission withdraws approval and reserves scaffold:planned; the gate's pass path does neither.
const admittedAfter = (events, approvalId) => {
  const i = events.findIndex((e) => e.id === approvalId);
  return events.slice(i + 1).some((e) => (e.event === 'unlabeled' && e.label?.name === 'scaffold:plan-approved')
    || (e.event === 'labeled' && e.label?.name === 'scaffold:planned'));
};

// Returns the job summary lines, or a skip reason. `configError` is set when scaffold-config.yml is invalid.
export async function runGate(gh, repo, { event, schema, config, configError }) {
  if (event.issue.pull_request) return { skip: 'pull request' };
  if (event.action === 'labeled' && event.label?.name !== 'scaffold:plan-approved') return { skip: 'label is not scaffold:plan-approved' };
  // An edit counts if the comment was the plan before or after it, so removing or moving the marker can't hide it.
  const touched = ['edited', 'deleted'].includes(event.action);
  if (touched && ![event.comment?.body, event.changes?.body?.from].some((b) => b?.startsWith(PLAN_MARKER))) {
    return { skip: 'comment is not the plan' };
  }

  const issue = await gh.get(`/repos/${repo}/issues/${event.issue.number}`);
  const labels = issue.labels.map((l) => l.name);
  const { setLabels, findComment, findComments, upsertStatus, events } = issueSteps(gh, repo, issue.number, labels);
  const updateStatus = async (states, next) => upsertStatus(setGates((await findComment(MARKER))?.body, states, next));
  const approvedLabel = labels.includes('scaffold:plan-approved');

  const plans = await findComments(PLAN_MARKER);
  const planComment = plans[0];
  // No plan left: back to Ready, which also frees the in-flight slot (PLAN.md section 8).
  if (!planComment && (touched || approvedLabel)) {
    const what = touched ? 'plan deleted or its marker removed' : 'no plan';
    await setLabels(['scaffold:ready'], ['scaffold:planned', 'scaffold:plan-approved']);
    await updateStatus({ Plan: `🗑️ ${what}`, Approval: '⏳ pending' }, 'a member comments `/plan` to plan again.');
    return { lines: ['### SCAFFOLD plan gate', `${what[0].toUpperCase()}${what.slice(1)}: approval withdrawn, back to \`scaffold:ready\``] };
  }
  if (!approvedLabel) return { skip: 'scaffold:plan-approved is not applied' };

  const allEvents = await events();
  const result = configError
    ? { ok: false, reason: `\`.github/scaffold-config.yml\` is invalid: ${escapeForComment(configError)}` }
    : plans.length > 1
      ? { ok: false, reason: 'more than one comment is marked as the plan: delete the extra one, or comment `/plan` again' }
      : evaluateApproval({
        events: allEvents,
        author: issue.user?.login,
        approvers: config.approvers,
        planComment,
        plan: decodePlan(planComment.body, schema),
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
  const plan = decodePlan(planComment.body, schema);
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
  if (admittedAfter(await events(), result.eventId)) {
    await setLabels(['scaffold:planned'], []);
    return audit('superseded by /plan', extra);
  }
  await updateStatus(states, plan.split === 'sub-tickets'
    ? 'developers assign each sub-ticket to Copilot when its blockers are done (coming in slice 3).'
    : 'a developer assigns this issue to Copilot (coming in slice 3).');
  return audit('pass', extra);
}

// The planned → approved gate (PLAN.md section 6, slice 2), with the client injected so tests can fake it.
// Runs when scaffold:plan-approved is applied, when any bot comment is edited or deleted, and when a
// scenarios comment is (a member may write it by hand when intake is off). No model call.
//
// `/plan` admission runs in a different concurrency group, so it can change this issue while the gate
// runs. The gate reads the issue fresh, and after writing checks whether an admission came after the
// approval it checked. The plan job shares this gate's per-issue group and sets the labels last.
import { issueSteps } from '../core/lib/issue.mjs';
import { MARKER, setGates, manualStates, manualBefore } from '../core/lib/status.mjs';
import { escapeForComment } from '../core/lib/text.mjs';
import { stageOnSince, enteredBefore } from '../core/lib/stages.mjs';
import { scenariosRequired, checkScenarios, scenarioComments, SCENARIOS_MARKER } from '../core/lib/scenarios.mjs';
import { PLAN_MARKER, decodePlan, isSubTicketPlan, evaluateApproval } from './rules.mjs';

const hours = (from, to) => ((Date.parse(to) - Date.parse(from)) / 3_600_000).toFixed(1);
// Lifecycle labels that mean the issue is not in flight, so a failed approval must not reserve a slot.
const NOT_IN_FLIGHT = ['scaffold:triage', 'scaffold:needs-info', 'scaffold:ready', 'scaffold:too-big'];

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
  const edited = ['edited', 'deleted'].includes(event.action);
  const was = (marker) => edited && [event.comment?.body, event.changes?.body?.from].some((b) => b?.startsWith(marker));
  const touched = was(PLAN_MARKER);
  // A changed scenarios comment voids an approved plan made against it (PLAN.md section 2, Scenarios),
  // with intake on or off: the approval is re-checked below and removed if it no longer holds.
  const scenariosTouched = !touched && was(SCENARIOS_MARKER);
  if (edited && !touched && !scenariosTouched) return { skip: 'comment is not the plan' };

  const issue = await gh.get(`/repos/${repo}/issues/${event.issue.number}`);
  const labels = issue.labels.map((l) => l.name);
  const { setLabels, findComment, findComments, upsertStatus, events } = issueSteps(gh, repo, issue.number, labels);
  const others = config ? manualStates(config) : {};
  const updateStatus = async (states, next) => upsertStatus(setGates((await findComment(MARKER))?.body, { ...others, ...states }, next));
  const approvedLabel = labels.includes('scaffold:plan-approved');
  if (scenariosTouched && !approvedLabel) return { skip: 'scenarios changed; no approved plan to withdraw' };
  if (scenariosTouched && config && !scenariosRequired(config, labels)) return { skip: 'scenarios changed but aren\'t required' };

  const plans = await findComments(PLAN_MARKER);
  const planComment = plans[0];
  if (!planComment && (touched || approvedLabel)) {
    // Planned by hand before the plan stage was turned on: the package leaves it to the humans (PLAN.md section 5).
    if (config && enteredBefore(await events(), 'scaffold:planned', await stageOnSince(gh, repo, 'plan'))) {
      await updateStatus({ Plan: manualBefore('plan'), Approval: manualBefore('plan') });
      return { lines: ['### SCAFFOLD plan gate', 'Planned before the `plan` stage was on: left to the humans (manual)'] };
    }
    // A too-big ticket stays with triage to be split, not back to Ready (PLAN.md section 8).
    if (labels.includes('scaffold:too-big')) {
      await setLabels([], ['scaffold:planned', 'scaffold:plan-approved']);
      return { skip: 'scaffold:too-big: left with triage to be split' };
    }
    // No plan left: back to Ready, which also frees the in-flight slot (PLAN.md section 8).
    const what = touched ? 'plan deleted or its marker removed' : 'no plan';
    await setLabels(['scaffold:ready'], ['scaffold:planned', 'scaffold:plan-approved']);
    await updateStatus({ Plan: `🗑️ ${what}`, Approval: '⏳ pending' }, 'a member comments `/plan` to plan again.');
    return { lines: ['### SCAFFOLD plan gate', `${what[0].toUpperCase()}${what.slice(1)}: approval withdrawn, back to \`scaffold:ready\``] };
  }
  if (!approvedLabel) return { skip: 'scaffold:plan-approved is not applied' };

  const timeline = configError ? [] : await events();
  const scenarios = !configError && scenariosRequired(config, labels)
    ? checkScenarios({ events: timeline, issue: issue.number, author: issue.user?.login, approvers: config.approvers, comments: await scenarioComments(gh, repo, issue.number) })
    : null;
  const result = configError
    ? { ok: false, reason: `\`.github/scaffold-config.yml\` is invalid: ${escapeForComment(configError)}` }
    : plans.length > 1
      ? { ok: false, reason: 'more than one comment is marked as the plan: delete the extra one, or comment `/plan` again' }
      : evaluateApproval({
        events: timeline,
        scenarios,
        author: issue.user?.login,
        approvers: config.approvers,
        planComment,
        plan: decodePlan(planComment.body, schema),
        subTickets: isSubTicketPlan(planComment.body),
        limits: config.pr_size,
        maxStack: config.max_stack_prs,
      });
  const audit = (outcome) => ({
    lines: [
      '### SCAFFOLD plan gate',
      '| Gate | Outcome | Applied by | Plan hash | Hours from plan to approval |',
      '| --- | --- | --- | --- | --- |',
      `| Planned → approved | ${outcome} | ${result.approver ?? '-'} | ${result.hash ? `\`${result.hash}\`` : '-'} | ${result.at ? hours(planComment.updated_at, result.at) : '-'} |`,
    ],
  });

  if (!result.ok) {
    // A sub-ticket plan keeps its in-flight slot (Phase 1b cutover); an issue not in flight isn't given one.
    await setLabels(labels.some((l) => NOT_IN_FLIGHT.includes(l)) ? [] : ['scaffold:planned'], ['scaffold:plan-approved']);
    await updateStatus({ Approval: `❌ not approved: ${result.reason}` }, 'a listed approver applies `scaffold:plan-approved` again once the problem is fixed.');
    return audit(`fail: ${result.reason}`);
  }

  await setLabels([], ['scaffold:planned']);
  if (admittedAfter(await events(), result.eventId)) {
    await setLabels(['scaffold:planned'], []);
    return audit('superseded by /plan');
  }
  await updateStatus(
    { Approval: `✅ approved by \`${result.approver}\` (plan \`${result.hash}\`)` },
    'a developer assigns this issue to Copilot (coming in slice 3).',
  );
  return audit('pass');
}

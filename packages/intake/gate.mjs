// The scenarios → approved gate (PLAN.md sections 2 and 6, slice 2b), with the client injected so tests can
// fake it. No model call. Runs when a human applies or removes scaffold:gherkin-approved or
// scaffold:needs-gherkin, and when a bot comment is edited or deleted.
//
// Labels written with GITHUB_TOKEN don't start runs, so every event here is a human's (or another app's).
import { issueSteps } from '../core/lib/issue.mjs';
import { MARKER, setGates, manualStates } from '../core/lib/status.mjs';
import { escapeForComment } from '../core/lib/text.mjs';
import { stageOn } from '../core/lib/config.mjs';
import { parseGherkin, scenariosText, SCENARIOS_MARKER } from '../core/lib/gherkin.mjs';
import { checkScenarios, scenarioComments } from '../core/lib/scenarios.mjs';
import { parseProblem, APPROVED, NEEDS, APPROVE_NEXT, isTriaged } from './scenarios.mjs';

const PLANNED = ['scaffold:planned', 'scaffold:plan-approved'];
const heading = '### SCAFFOLD scenarios gate';

const hours = (from, to) => ((Date.parse(to) - Date.parse(from)) / 3_600_000).toFixed(1);

// Returns { skip } or { lines } for the job summary. `configError` is set when scaffold-config.yml is invalid.
export async function runScenariosGate(gh, repo, { event, config, configError }) {
  if (event.issue.pull_request) return { skip: 'pull request' };
  const labelEvent = ['labeled', 'unlabeled'].includes(event.action);
  const touched = ['edited', 'deleted'].includes(event.action);
  if (labelEvent && ![APPROVED, NEEDS].includes(event.label?.name)) return { skip: `label is not ${APPROVED} or ${NEEDS}` };
  // An edit counts if the comment was the scenarios before or after it, so removing the marker can't hide it.
  if (touched && ![event.comment?.body, event.changes?.body?.from].some((b) => b?.startsWith(SCENARIOS_MARKER))) {
    return { skip: 'comment is not the scenarios' };
  }
  if (!labelEvent && !touched) return { skip: 'not a scenarios event' };
  if (config?.gherkin === 'off') return { skip: 'scenarios are off (`gherkin: off`)' };

  const issue = await gh.get(`/repos/${repo}/issues/${event.issue.number}`);
  const labels = issue.labels.map((l) => l.name);
  const { setLabels, findComment, upsertStatus, events, hasWriteAccess } = issueSteps(gh, repo, issue.number, labels);
  const others = config ? manualStates(config) : {};
  const updateStatus = async (states, next) => upsertStatus(setGates((await findComment(MARKER))?.body, { ...others, ...states }, next));
  const planned = labels.some((l) => PLANNED.includes(l));
  const triaged = isTriaged(labels, { removedNeeds: event.action === 'unlabeled' && event.label?.name === NEEDS });
  const planOn = stageOn(config, 'plan');
  const afterApproval = planned
    ? 'a member comments `/plan` again so the plan maps the approved scenarios.'
    : planOn ? 'a member comments `/plan` to get a plan.' : 'plan by hand: see `packages/plan/HANDOFF.md`.';
  const done = (outcome, extra = {}) => ({
    lines: [
      heading,
      '| Gate | Event | Outcome | By | Scenarios hash | Hours from scenarios to approval |',
      '| --- | --- | --- | --- | --- | --- |',
      `| Scenarios → approved | ${event.action}${event.label ? ` ${event.label.name}` : ''} | ${outcome} | ${extra.by ?? event.sender?.login ?? '-'} | ${extra.hash ? `\`${extra.hash}\`` : '-'} | ${extra.hours ?? '-'} |`,
    ],
  });

  // Back to needs-gherkin. A planned issue keeps its in-flight slot but loses its plan approval (PLAN.md section 2).
  async function withdraw(state, outcome) {
    if (!triaged) {
      await setLabels([], [APPROVED]);
      return done(`${outcome} (not triaged yet)`);
    }
    const hadPlanApproval = labels.includes('scaffold:plan-approved');
    await setLabels([NEEDS], [APPROVED, 'scaffold:ready', 'scaffold:plan-approved']);
    await updateStatus(
      { Scenarios: state, ...(hadPlanApproval ? { Approval: '⏳ withdrawn: the scenarios changed' } : {}) },
      planned ? `${APPROVE_NEXT.replace(/\.$/, '')}; then a member comments \`/plan\` again.` : APPROVE_NEXT,
    );
    return done(outcome);
  }

  // Edited or deleted: any change withdraws an approval; otherwise the row shows the new state.
  if (touched) {
    const current = await scenarioComments(gh, repo, issue.number);
    const gone = !current.length;
    if (labels.includes(APPROVED)) {
      return withdraw(gone ? '🗑️ scenarios deleted: approval withdrawn' : '✏️ scenarios edited: approval withdrawn', 'withdrawn');
    }
    if (gone) {
      await updateStatus({ Scenarios: '🗑️ scenarios deleted' }, 'write scenarios in the issue\'s Scenarios (Gherkin) field, then add the `scaffold:triage` label.');
      return done('deleted');
    }
    const errors = parseGherkin(scenariosText(current[0].body) ?? '').errors;
    await updateStatus(
      { Scenarios: errors.length ? `⚠️ the scenarios don't parse: ${parseProblem(errors)}` : '📝 scenarios edited: waiting for a listed approver' },
      errors.length ? 'fix the scenarios comment, then a listed approver applies `scaffold:gherkin-approved`.' : APPROVE_NEXT,
    );
    return done(errors.length ? 'edited: does not parse' : 'edited');
  }

  if (event.label.name === APPROVED && event.action === 'unlabeled') {
    return withdraw('⏳ approval removed', 'approval removed');
  }

  if (event.label.name === APPROVED) {
    const required = config?.gherkin === 'always' || labels.includes(NEEDS);
    const fail = async (reason, extra) => {
      await setLabels(required && triaged ? [NEEDS] : [], [APPROVED, ...(required ? ['scaffold:ready'] : [])]);
      await updateStatus({ Scenarios: `❌ not approved: ${reason}` }, `${APPROVE_NEXT.replace(/\.$/, '')} again once the problem is fixed.`);
      return done(`fail: ${reason}`, extra);
    };
    if (configError) return fail(`\`.github/scaffold-config.yml\` is invalid: ${escapeForComment(configError)}`);
    if (!triaged) return fail('the issue hasn\'t been triaged as ready yet');
    const comments = await scenarioComments(gh, repo, issue.number);
    const result = checkScenarios({ events: await events(), issue: issue.number, author: issue.user?.login, approvers: config.approvers, comments });
    const extra = { by: result.approver, hash: result.hash, hours: result.at && comments.length === 1 ? hours(comments[0].updated_at, result.at) : undefined };
    if (!result.ok) return fail(result.reason, extra);

    await setLabels(planned ? [] : ['scaffold:ready'], [NEEDS]);
    const n = result.ids.length;
    await updateStatus(
      {
        Scenarios: `✅ approved by \`${result.approver}\` (${n} scenario${n === 1 ? '' : 's'}, \`${result.hash}\`)`,
        ...(planOn && !planned ? { Plan: '⏳ waiting for `/plan`' } : {}),
      },
      afterApproval,
    );
    return done('pass', extra);
  }

  // scaffold:needs-gherkin applied or removed by hand. Under `always` it can't be overridden; under
  // `auto` a member (write access) can, to overrule triage (PLAN.md section 2, Scenarios).
  if (!triaged) return { skip: 'not triaged yet: triage sets scaffold:needs-gherkin' };
  const member = config?.gherkin === 'auto' && await hasWriteAccess(event.sender);
  if (event.action === 'unlabeled') {
    if (labels.includes(APPROVED)) return { skip: 'scenarios already approved' };
    if (!member) {
      await setLabels([NEEDS], ['scaffold:ready']);
      const why = config?.gherkin === 'always'
        ? '⏳ required: `gherkin: always` (label re-applied; change `gherkin` in `.github/scaffold-config.yml` to stop requiring scenarios)'
        : '⏳ required (label re-applied: only a member with write access can remove it)';
      await updateStatus({ Scenarios: why }, APPROVE_NEXT);
      return done('re-applied');
    }
    await setLabels(planned ? [] : ['scaffold:ready'], []);
    await updateStatus({ Scenarios: `➖ not needed (\`${NEEDS}\` removed by \`${event.sender.login}\`)` }, afterApproval);
    return done('override: not needed');
  }
  if (config?.gherkin === 'always') return { skip: 'already required under `gherkin: always`' };
  if (!member || labels.includes(APPROVED)) {
    await setLabels([], [NEEDS]);
    return done(member ? 'already approved: label removed' : 'removed: only a member with write access can require scenarios');
  }
  await setLabels([], ['scaffold:ready', 'scaffold:plan-approved']);
  await updateStatus({ Scenarios: `⏳ required (added by \`${event.sender.login}\`)` }, APPROVE_NEXT);
  return done('override: required');
}

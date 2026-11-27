// `/gherkin` (PLAN.md section 2, Scenarios): a member asks gherkin-writer to draft or redraft the
// scenarios, with the client and model injected so tests can fake them. A redraft withdraws any
// approval, as an edit would: GITHUB_TOKEN's edit doesn't start the scenarios gate, so this does it.
import { issueSteps } from '../core/lib/issue.mjs';
import { MARKER, setGates, manualStates } from '../core/lib/status.mjs';
import { escapeForComment } from '../core/lib/text.mjs';
import { stageOn } from '../core/lib/config.mjs';
import { scenariosText } from '../core/lib/gherkin.mjs';
import { SCENARIOS_MARKER, APPROVED, NEEDS, NOT_TRIAGED, APPROVE_NEXT } from './scenarios.mjs';
import { draftScenarios, draftAudit } from './writer.mjs';

const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const heading = '### SCAFFOLD /gherkin';

export const isGherkinCommand = (body) => /^\/gherkin(\s|$)/.test(body ?? '');

// Returns { skip } or { lines } for the job summary. `config` is null when `configError` is set.
export async function runGherkin(gh, repo, { event, config, configError, loadSkill, callModel }) {
  if (event.issue.pull_request) return { skip: 'pull request' };
  const comment = event.comment;
  if (event.action !== 'created' || !isGherkinCommand(comment?.body)) return { skip: 'comment is not /gherkin' };
  const react = (content) => gh.post(`/repos/${repo}/issues/comments/${comment.id}/reactions`, { content });
  if (!TRUSTED.includes(comment.author_association) || comment.user?.type !== 'User') {
    await react('confused');
    return { skip: `/gherkin by ${comment.author_association} ${comment.user?.type}: members only` };
  }

  const issue = await gh.get(`/repos/${repo}/issues/${event.issue.number}`);
  const labels = issue.labels.map((l) => l.name);
  const { setLabels, findComment, upsertComment, upsertStatus } = issueSteps(gh, repo, issue.number, labels);
  const updateStatus = async (states, next) => upsertStatus(setGates((await findComment(MARKER))?.body, { ...(config ? manualStates(config) : {}), ...states }, next));
  const refuse = async (reason, row, next) => {
    await react('confused');
    if (row) await updateStatus({ Scenarios: row }, next);
    return { skip: reason };
  };
  if (configError) {
    return refuse(`invalid config: ${configError}`, `⛔ \`.github/scaffold-config.yml\` is invalid: ${escapeForComment(configError)}`, 'fix `.github/scaffold-config.yml`, then comment `/gherkin` again.');
  }
  if (config.gherkin === 'off') return refuse('scenarios are off (`gherkin: off`)');
  if (labels.some((l) => NOT_TRIAGED.includes(l))) return refuse('not triaged yet: `/gherkin` works once triage has finished');

  await react('eyes');
  const previous = await findComment(SCENARIOS_MARKER);
  const draft = await draftScenarios({
    issue,
    triage: (await findComment(MARKER))?.body.replace(MARKER, ''),
    previous: previous ? scenariosText(previous.body) : null,
    guidance: comment.body.replace(/^\/gherkin\s*/, ''),
    approvers: config.approvers,
    loadSkill,
    callModel,
  });
  if (draft.error) {
    // Nothing posted: the current scenarios and any approval stand.
    await updateStatus({ Scenarios: `⚠️ \`/gherkin\` failed: ${draft.error}` }, 'comment `/gherkin` again to retry.');
    return { lines: [heading, ...draftAudit(draft), '', `\`${escapeForComment(draft.detail)}\``] };
  }

  const posted = await upsertComment(SCENARIOS_MARKER, draft.body);
  const planned = labels.some((l) => ['scaffold:planned', 'scaffold:plan-approved'].includes(l));
  const hadPlanApproval = labels.includes('scaffold:plan-approved');
  await setLabels([NEEDS], [APPROVED, 'scaffold:ready', 'scaffold:plan-approved']);
  await updateStatus(
    {
      Scenarios: `📝 [${draft.count} ${previous ? 'redrafted' : 'drafted'}](${posted.html_url}): waiting for a listed approver`,
      ...(hadPlanApproval ? { Approval: '⏳ withdrawn: the scenarios changed' } : {}),
      ...(stageOn(config, 'plan') && !planned ? { Plan: '⏳ waiting for approved scenarios' } : {}),
    },
    planned ? `${APPROVE_NEXT.replace(/\.$/, '')}; then a member comments \`/plan\` again.` : APPROVE_NEXT,
  );
  return { lines: [heading, ...draftAudit(draft)] };
}

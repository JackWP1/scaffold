// Triage (PLAN.md section 2, slice 1), with the client and model injected so tests can fake them.
// Imports only from core (PLAN.md section 5); hands over to plan through labels and the status comment.
import { createHash } from 'node:crypto';
import { wrapUntrusted, escapeForComment } from '../core/lib/text.mjs';
import { validate } from '../core/lib/validate.mjs';
import { RateLimited } from '../core/lib/models.mjs';
import { issueSteps } from '../core/lib/issue.mjs';
import { renderTriage, renderNotice } from './render.mjs';
import { usesTemplate, formGherkin } from './template.mjs';
import { renderScenarios, parseProblem, SCENARIOS_MARKER } from './scenarios.mjs';

const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
// Re-triage resets the lifecycle, so a planned or approved issue needs /plan again (PLAN.md section 8).
export const STATE_LABELS = ['scaffold:triage', 'scaffold:needs-info', 'scaffold:needs-gherkin', 'scaffold:gherkin-approved', 'scaffold:ready', 'scaffold:proposed', 'scaffold:planned', 'scaffold:plan-approved', 'scaffold:too-big'];
// The plan package's marked comment (handover contract, PLAN.md section 5): read, never imported.
const PLAN_MARKER = '<!-- scaffold:plan -->';

const heading = '### SCAFFOLD triage';
const APPROVE_NEXT = 'a listed approver reviews the scenarios and applies `scaffold:gherkin-approved`.';

// Whether a ready issue needs approved scenarios first (PLAN.md section 2, Scenarios).
export const scenariosRequired = (mode, triageSays) => mode === 'always' || (mode === 'auto' && triageSays);

// Returns the job summary (markdown). `config` is null when `configError` is set.
export async function runTriage(gh, repo, { event, config, configError, loadSkill, callModel }) {
  const issue = event.issue;
  const labels = issue.labels.map((l) => l.name);
  const skip = (reason) => `${heading}\nSkipped: ${reason}`;
  if (issue.pull_request) return skip('pull request');
  if (event.action === 'edited') return skip('edits do not re-run triage; add scaffold:triage instead');
  if (event.action === 'unlabeled') return skip('removing a label does not re-run triage');
  if (event.action === 'labeled' && !['scaffold:accepted', 'scaffold:triage'].includes(event.label?.name)) return skip('label is not scaffold:accepted or scaffold:triage');

  const { setLabels, upsertStatus, upsertComment, acceptedByMember, findComment } = issueSteps(gh, repo, issue.number, labels);
  const trusted = TRUSTED.includes(issue.author_association)
    || (labels.includes('scaffold:accepted') && await acceptedByMember(event.action === 'labeled' && event.label.name === 'scaffold:accepted' ? event.sender : undefined));
  if (!trusted) {
    const notice = labels.includes('scaffold:accepted')
      ? '🔒 Opened by someone outside the team, and `scaffold:accepted` was not applied by a member with write access. A member must re-apply it before SCAFFOLD triages this issue.'
      : '🔒 Opened by someone outside the team. A member must apply `scaffold:accepted` before SCAFFOLD triages it.';
    await setLabels(['scaffold:proposed'], STATE_LABELS);
    await upsertStatus(renderNotice(notice));
    return `${heading}\nNot trusted (${issue.author_association}): labelled scaffold:proposed`;
  }
  if (configError) {
    await upsertStatus(renderNotice(`⛔ \`.github/scaffold-config.yml\` is invalid: ${escapeForComment(configError)}. Fix it, then add the \`scaffold:triage\` label to triage this issue.`));
    return `${heading}\nInvalid config (no model call): ${configError}`;
  }

  // A ticket the plan found too big comes back here; triage proposes smaller tickets (PLAN.md section 2).
  const tooBig = labels.includes('scaffold:too-big');
  await setLabels(['scaffold:triage'], STATE_LABELS);

  const { system, schema, version: skillVersion, model } = await loadSkill();
  const parts = ['Triage this issue.', wrapUntrusted('untrusted_issue', `Title: ${issue.title}\n\n${issue.body ?? ''}`)];
  if (tooBig) {
    const plan = await findComment(PLAN_MARKER);
    parts.push(
      `This issue was planned and found too big: it needs more than ${config.max_stack_prs} PRs (max_stack_prs). Propose smaller tickets in \`proposed_tickets\`, unless the issue has since been narrowed so that it fits.`,
      wrapUntrusted('untrusted_plan', plan?.body.replace(/<!-- scaffold:plan-data [^>]* -->/, '') ?? '(none)'),
    );
  }
  const user = parts.join('\n\n');
  const inputHash = createHash('sha256').update(user).digest('hex').slice(0, 16);

  let out;
  try {
    out = await callModel({ model, system, user, schema });
  } catch (err) {
    const why = err instanceof RateLimited ? 'Copilot is rate limiting' : 'the model call failed';
    console.warn(err.message);
    await setLabels(tooBig ? ['scaffold:too-big'] : [], ['scaffold:triage']);
    await upsertStatus(renderNotice(`⚠️ Triage skipped: ${why}. Add the \`scaffold:triage\` label or re-run the workflow to try again.`));
    return `${heading}\nSkipped: ${why}\n\n\`${err.message.slice(0, 500)}\``;
  }

  const errors = validate(schema, out);
  if (errors.length) {
    console.log(`::warning::Invalid triage output: ${errors.join('; ')}`);
    await setLabels(tooBig ? ['scaffold:too-big'] : [], ['scaffold:triage']);
    await upsertStatus(renderNotice('⚠️ Triage produced invalid output, so nothing was applied. Re-run the workflow to try again.'));
    return `${heading}\nInvalid output (no writes):\n\n- ${errors.join('\n- ')}`;
  }
  if (out.decision === 'ready') out.questions = [];
  if (!tooBig) out.proposed_tickets = [];
  const split = out.proposed_tickets.length > 0;
  const needsScenarios = !split && out.decision === 'ready' && scenariosRequired(config.gherkin, out.scenarios_needed);

  // The author's scenarios go in the scenarios comment for approval; gherkin-writer drafts them otherwise.
  async function scenarios() {
    const fromForm = formGherkin(issue.body);
    if (fromForm) {
      const r = renderScenarios(fromForm, { issue: issue.number, source: 'the issue\'s Scenarios (Gherkin) field', approvers: config.approvers });
      if (r.errors) {
        return { state: `⚠️ the Scenarios (Gherkin) field doesn't parse: ${parseProblem(r.errors)}`, next: 'fix the issue\'s Scenarios (Gherkin) field, then add the `scaffold:triage` label.' };
      }
      const c = await upsertComment(SCENARIOS_MARKER, r.body);
      return { state: `📝 [${r.count} scenario${r.count === 1 ? '' : 's'}](${c.html_url}): waiting for a listed approver`, next: APPROVE_NEXT };
    }
    const existing = await findComment(SCENARIOS_MARKER);
    if (existing) return { state: `📝 [scenarios](${existing.html_url}): waiting for a listed approver`, next: APPROVE_NEXT };
    return { state: '⏳ no scenarios yet', next: 'write scenarios in the issue\'s Scenarios (Gherkin) field, then add the `scaffold:triage` label.' };
  }
  const scenarioState = needsScenarios ? await scenarios() : undefined;

  const add = [split ? 'scaffold:too-big' : needsScenarios ? 'scaffold:needs-gherkin' : `scaffold:${out.decision}`];
  if (!labels.some((l) => l.startsWith('priority:'))) add.push(`priority:${out.priority}`);
  if (!usesTemplate(issue.body)) add.push('scaffold:no-template');
  await setLabels(add, [...STATE_LABELS, 'scaffold:no-template']);
  await upsertStatus(renderTriage(out, { skillVersion, model }, { config, scenarios: scenarioState }));

  return [
    heading,
    '| Skill | Version | Model | Input hash | Decision |',
    '| --- | --- | --- | --- | --- |',
    `| triage | ${skillVersion} | ${model} | \`${inputHash}\` | ${split ? `too big: ${out.proposed_tickets.length} smaller tickets proposed` : needsScenarios ? 'needs-gherkin' : out.decision} |`,
    '',
    '<details><summary>Validated output</summary>',
    '',
    '```json',
    JSON.stringify(out, null, 2),
    '```',
    '</details>',
  ].join('\n');
}

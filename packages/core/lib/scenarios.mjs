// Scenario approval, shared by intake's scenarios gate and the plan package (PLAN.md sections 2 and 5).
// Plan re-checks it rather than trusting the label, with intake on or off: a manual scenarios comment
// (packages/intake/templates/manual-gherkin.md) passes the same check.
import { checkApproval } from './approval.mjs';
import { escapeForComment } from './text.mjs';
import { parseGherkin, scenariosText, scenarioTag, SCENARIOS_MARKER } from './gherkin.mjs';

export { SCENARIOS_MARKER };
export const GHERKIN_APPROVED = 'scaffold:gherkin-approved';
export const NEEDS_GHERKIN = 'scaffold:needs-gherkin';

// Whether an issue needs approved scenarios before it is planned: always under `gherkin: always`;
// under `auto`, once triage or a member has asked for them (either label is on the issue), or when a
// person revoked the approval and nothing has reset that since (a re-triage, or a member removing
// scaffold:needs-gherkin). The timeline covers the moment before the intake gate re-applies
// scaffold:needs-gherkin, and intake being off. SCAFFOLD's own removals always come with
// scaffold:needs-gherkin or a re-triage, so only a person's removal counts.
export function scenariosRequired(config, labels, events = []) {
  if (config?.gherkin === 'always') return true;
  if (config?.gherkin !== 'auto') return false;
  if (labels.some((l) => [NEEDS_GHERKIN, GHERKIN_APPROVED].includes(l))) return true;
  const last = events.filter((e) => (e.event === 'labeled' && [NEEDS_GHERKIN, GHERKIN_APPROVED, 'scaffold:triage'].includes(e.label?.name))
    || (e.event === 'unlabeled' && (e.label?.name === NEEDS_GHERKIN || (e.label?.name === GHERKIN_APPROVED && e.actor?.type === 'User')))).at(-1);
  return last?.event === 'unlabeled' && last.label.name === GHERKIN_APPROVED;
}

const BOT = 'github-actions[bot]';
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];

// Comments marked as the scenarios: SCAFFOLD's, or a member's written by hand from the manual template
// when intake is off. More than one fails the check, so an extra one can block but never pass it.
export async function scenarioComments(gh, repo, number) {
  const found = [];
  for await (const page of gh.pages(`/repos/${repo}/issues/${number}/comments`)) {
    found.push(...page.filter((c) => c.body?.startsWith(SCENARIOS_MARKER) && (c.user?.login === BOT || TRUSTED.includes(c.author_association))));
  }
  return found;
}

// Gherkin errors for a comment or status row: escaped, no table pipes, at most three.
export const gherkinProblem = (errors) => escapeForComment(errors.slice(0, 3).join('; ') + (errors.length > 3 ? `; and ${errors.length - 3} more` : '')).replaceAll('|', '\\|');

// The timeline check on scaffold:gherkin-approved against the one scenarios comment, then the Gherkin:
// it must parse and scenario n must carry `@scaffold-<issue>-S<n>`. Returns checkApproval's result,
// plus `ids` (['S1', …]) when ok; `hash` is the approved comment's.
export function checkScenarios({ events, issue, author, approvers, comments }) {
  if (comments.length > 1) return { ok: false, reason: 'more than one comment is marked as the scenarios: delete the extra one' };
  const comment = comments[0];
  const approval = checkApproval({
    events, label: GHERKIN_APPROVED, author, approvers, comment, what: 'scenarios', missing: 'there are no scenarios to approve',
  });
  if (!approval.ok) return approval;
  const fail = (reason) => ({ ...approval, ok: false, reason, hash: undefined });
  const { scenarios, errors } = parseGherkin(scenariosText(comment.body) ?? '');
  if (errors.length) return fail(`the scenarios don't parse: ${gherkinProblem(errors)}`);
  const untagged = scenarios.findIndex((s, i) => !s.tags.includes(scenarioTag(issue, i + 1)));
  if (untagged >= 0) return fail(`scenario ${untagged + 1} isn't tagged \`${scenarioTag(issue, untagged + 1)}\``);
  return { ...approval, ids: scenarios.map((_, i) => `S${i + 1}`), comment };
}

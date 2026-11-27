// The scenarios comment (PLAN.md section 2, Scenarios): one marked comment per issue holding the
// Gherkin a listed approver approves, numbered S1, S2, … by tag. Only Actions code writes it.
import { escapeForComment as e } from '../core/lib/text.mjs';
import { SCENARIOS_MARKER, tagScenarios } from '../core/lib/gherkin.mjs';
import { GHERKIN_APPROVED, NEEDS_GHERKIN, gherkinProblem } from '../core/lib/scenarios.mjs';

export { SCENARIOS_MARKER };

// Shared by triage, the scenarios gate and /gherkin.
export const APPROVED = GHERKIN_APPROVED;
export const NEEDS = NEEDS_GHERKIN;
// Before triage has finished: scenarios approval doesn't apply yet.
export const NOT_TRIAGED = ['scaffold:triage', 'scaffold:needs-info', 'scaffold:proposed', 'scaffold:too-big'];
// Left by triage (or a manual triage) and the stages after it.
const TRIAGED = [NEEDS_GHERKIN, 'scaffold:ready', 'scaffold:planned', 'scaffold:plan-approved'];

// An issue with no lifecycle label hasn't been triaged. `removedNeeds` is set when the event being
// handled removed scaffold:needs-gherkin, which was then the issue's lifecycle label.
export const isTriaged = (labels, { removedNeeds = false } = {}) => !labels.some((l) => NOT_TRIAGED.includes(l))
  && (removedNeeds || labels.some((l) => TRIAGED.includes(l)));
export const APPROVE_NEXT = 'a listed approver reviews the scenarios and applies `scaffold:gherkin-approved`.';

const cell = (text) => e(text).replaceAll('|', '\\|');
// Longer than any backtick run in the text, so the Gherkin can't close its fence.
const fence = (text) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(([m]) => m.length + 1)));

// `source` says where the scenarios came from (trusted, written by Actions code); `notes` are the
// drafter's questions for the approver (untrusted, escaped). Returns { body, count } or { errors }
// when the Gherkin doesn't parse.
export function renderScenarios(gherkin, { issue, source, approvers = [], notes = [] }) {
  const { text, scenarios, errors } = tagScenarios(gherkin, issue);
  if (errors.length) return { errors };
  const f = fence(text);
  const who = approvers.length ? `A listed approver (${approvers.map((a) => `\`${a}\``).join(', ')})` : 'A listed approver';
  const body = [
    SCENARIOS_MARKER,
    '### SCAFFOLD scenarios',
    '',
    `Source: ${source}. These are what "done" looks like: the plan, tests and review are checked against them.`,
    '',
    '| # | Scenario |',
    '| --- | --- |',
    ...scenarios.map((s, i) => `| S${i + 1} | ${cell(s.name)} |`),
    '',
    `${f}gherkin`,
    text,
    f,
    '',
    ...(notes.length ? ['**Check before approving**', '', ...notes.map((n) => `- ${e(n)}`), ''] : []),
    `${who} who isn't the issue author reviews these and applies \`scaffold:gherkin-approved\`. Any edit to this comment withdraws the approval.`,
  ].join('\n');
  return { body, count: scenarios.length };
}

// Gherkin parse errors for a status row, escaped and kept short.
export const parseProblem = gherkinProblem;

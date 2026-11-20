// Renders the plan comment and sub-ticket bodies. All model text is escaped.
import { escapeForComment as e } from '../lib/text.mjs';
import { PLAN_MARKER, encodePlan } from './rules.mjs';

const list = (items) => items.map((i) => `- ${e(i)}`).join('\n');
const code = (items) => items.map((i) => `- \`${String(i).replace(/[`\s]+/g, ' ').trim()}\``).join('\n');
const size = (est) => `${est.files} files / ${est.lines} lines`;

export const SPLIT = {
  none: 'one PR',
  stack: 'a stack of PRs, merged bottom-up',
  'sub-tickets': 'sub-tickets, created as sub-issues when the plan is approved',
  'too-big': 'too big: needs more than 5 sub-tickets',
};

export function splitSummary(plan) {
  const n = plan.subtasks.length;
  if (plan.split === 'stack') return `stack of ${n} PRs`;
  if (plan.split === 'sub-tickets') return `${n} sub-tickets`;
  return SPLIT[plan.split];
}

export function renderPlan(plan, { problems, skillVersion, model, limits }) {
  const parts = [
    PLAN_MARKER,
    '### SCAFFOLD plan',
    '',
    `**Estimated size:** ${size(plan.estimate)} (soft limit ${size(limits.soft)}) · **Delivered as:** ${SPLIT[plan.split]}`,
  ];
  if (problems.length) parts.push('', '> [!WARNING]', '> This plan can\'t be approved as it stands:', ...problems.map((p) => `> - ${e(p)}`));
  parts.push('', '#### Approach', '', e(plan.approach));
  if (plan.acceptance_criteria.length) parts.push('', '#### Acceptance criteria', '', list(plan.acceptance_criteria));
  if (plan.affected_paths.length) parts.push('', '#### Affected paths', '', code(plan.affected_paths));
  parts.push('', `#### ${plan.split === 'stack' ? 'PRs in the stack' : plan.split === 'sub-tickets' ? 'Sub-tickets' : 'Sub-tasks'}`);
  for (const t of plan.subtasks) {
    const blocked = t.blocked_by.length ? ` · blocked by ${t.blocked_by.join(', ')}` : '';
    parts.push('', `**${t.id}. ${e(t.title)}** (${size(t.estimate)}${blocked})`, '', e(t.description));
    if (t.acceptance_criteria.length) parts.push('', list(t.acceptance_criteria));
  }
  if (plan.risks.length) parts.push('', '#### Risks', '', list(plan.risks));
  parts.push(
    '',
    '---',
    'A listed approver reviews this plan and applies `scaffold:plan-approved`. Editing this comment or commenting `/plan` again withdraws any approval.',
    '',
    `<sub>task-decomposer v${skillVersion} · ${model} · AI-generated: check before acting</sub>`,
    encodePlan(plan),
  );
  return parts.join('\n');
}

export const subTicketMarker = (parent, id) => `<!-- scaffold:sub-ticket ${parent}/${id} -->`;

// `numbers` maps earlier sub-task ids to their issue numbers, for the blocked-by links.
export function renderSubTicket(t, { parent, numbers }) {
  const blockers = t.blocked_by.map((b) => (numbers[b] ? `#${numbers[b]}` : `sub-task ${b}`));
  return [
    subTicketMarker(parent, t.id),
    `Sub-ticket ${t.id} of #${parent}. Planned and approved on the parent; comment \`/plan\` there, not here.`,
    '',
    '## What to build',
    '',
    e(t.description),
    '',
    '## Acceptance criteria',
    '',
    t.acceptance_criteria.map((c) => `- [ ] ${e(c)}`).join('\n') || '- [ ] See the parent plan',
    '',
    '## Blocked by',
    '',
    blockers.length ? blockers.map((b) => `- ${b}`).join('\n') : 'None (can start immediately)',
    '',
    `<sub>Estimated ${size(t.estimate)} · created by SCAFFOLD from the approved plan on #${parent}</sub>`,
  ].join('\n');
}

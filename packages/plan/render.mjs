// Renders the plan comment. All model text is escaped.
import { escapeForComment as e } from '../core/lib/text.mjs';
import { PLAN_MARKER, encodePlan, encodeScenarios } from './rules.mjs';

const list = (items) => items.map((i) => `- ${e(i)}`).join('\n');
const code = (items) => items.map((i) => `- \`${String(i).replace(/[`\s]+/g, ' ').trim()}\``).join('\n');
const size = (est) => `${est.files} files / ${est.lines} lines`;

export function splitText(split, maxStack) {
  if (split === 'stack') return 'a stack of PRs, merged bottom-up';
  if (split === 'too-big') return `too big: needs more than ${maxStack} PRs`;
  return 'one PR';
}

export function splitSummary(plan) {
  return plan.split === 'stack' ? `stack of ${plan.subtasks.length} PRs` : splitText(plan.split);
}

// `tooBig` renders the plan as sent back to triage rather than waiting for approval. `scenariosHash` is
// the approved scenarios comment's hash when scenarios are required: the gate checks it is unchanged.
export function renderPlan(plan, { problems, skillVersion, model, limits, maxStack, tooBig = false, scenariosHash = null }) {
  const parts = [
    PLAN_MARKER,
    '### SCAFFOLD plan',
    '',
    `**Estimated size:** ${size(plan.estimate)} (soft limit ${size(limits.soft)}) · **Delivered as:** ${tooBig ? splitText('too-big', maxStack) : splitText(plan.split, maxStack)}`,
  ];
  if (tooBig) {
    parts.push('', '> [!IMPORTANT]', `> This ticket needs more than one stack of ${maxStack} PRs (\`max_stack_prs\`), so it has gone back to triage to be split into smaller tickets.`);
  } else if (problems.length) {
    parts.push('', '> [!WARNING]', '> This plan can\'t be approved as it stands:', ...problems.map((p) => `> - ${e(p)}`));
  }
  parts.push('', '#### Approach', '', e(plan.approach));
  if (plan.acceptance_criteria.length) parts.push('', '#### Acceptance criteria', '', list(plan.acceptance_criteria));
  if (plan.affected_paths.length) parts.push('', '#### Affected paths', '', code(plan.affected_paths));
  if (plan.subtasks.length) parts.push('', `#### ${plan.split === 'stack' ? 'PRs in the stack' : 'Sub-tasks'}`);
  for (const t of plan.subtasks) {
    const blocked = t.blocked_by.length ? ` · blocked by ${t.blocked_by.join(', ')}` : '';
    parts.push('', `**${t.id}. ${e(t.title)}** (${size(t.estimate)}${blocked})`, '', e(t.description));
    if (t.acceptance_criteria.length) parts.push('', list(t.acceptance_criteria));
    if (scenariosHash && t.scenarios?.length) parts.push('', `Scenarios: ${t.scenarios.map((s) => e(s)).join(', ')}`);
  }
  if (plan.risks.length) parts.push('', '#### Risks', '', list(plan.risks));
  parts.push(
    '',
    '---',
    tooBig
      ? 'Triage proposes smaller tickets from this plan. A member creates them as new issues and closes this one as split.'
      : 'A listed approver reviews this plan and applies `scaffold:plan-approved`. Editing this comment or commenting `/plan` again withdraws any approval.',
    '',
    `<sub>task-decomposer v${skillVersion} · ${model} · AI-generated: check before acting</sub>`,
    encodePlan(plan),
    ...(scenariosHash ? [encodeScenarios(scenariosHash)] : []),
  );
  return parts.join('\n');
}

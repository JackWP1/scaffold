// Renders the SCAFFOLD status comment for triage. All model text is escaped.
import { escapeForComment as e } from '../lib/text.mjs';

export const MARKER = '<!-- scaffold:status -->';

const list = (items) => items.map((i) => `- ${e(i)}`).join('\n');

export function renderTriage(out, { skillVersion, model }) {
  const gate = out.decision === 'ready'
    ? '✅ **Triaged → ready.** A member can comment `/plan` (coming in slice 2).'
    : '❓ **Needs info.** Edit the issue to answer the questions below; triage re-runs on edit.';
  const parts = [
    MARKER,
    '### SCAFFOLD status',
    '',
    '| Gate | State |',
    '| --- | --- |',
    `| Triage | ${out.decision === 'ready' ? '✅ ready' : '❓ needs info'} |`,
    '| Plan | ⏳ pending |',
    '',
    gate,
    '',
    `**Summary:** ${e(out.summary)}`,
    `**Type:** ${out.type} · **Suggested priority:** ${out.priority}`,
  ];
  if (out.decision === 'needs-info' && out.questions.length) {
    parts.push('', '#### Questions', list(out.questions));
  }
  const b = out.brief;
  parts.push('', '<details><summary>Agent-ready brief</summary>', '', `**Goal:** ${e(b.goal)}`);
  if (b.acceptance_criteria.length) parts.push('', '**Acceptance criteria**', list(b.acceptance_criteria));
  if (b.affected_areas.length) parts.push('', '**Likely affected areas**', list(b.affected_areas));
  if (b.out_of_scope.length) parts.push('', '**Out of scope**', list(b.out_of_scope));
  parts.push('', '</details>', '', `<sub>triage v${skillVersion} · ${model} · AI-generated: check before acting</sub>`);
  return parts.join('\n');
}

export function renderNotice(text) {
  return [MARKER, '### SCAFFOLD status', '', text].join('\n');
}

// Renders the SCAFFOLD status comment for triage. All model text is escaped.
import { escapeForComment as e } from '../lib/text.mjs';

export const MARKER = '<!-- scaffold:status -->';

const list = (items) => items.map((i) => `- ${e(i)}`).join('\n');

const footer = ({ skillVersion, model }) => `<sub>triage v${skillVersion} · ${model} · AI-generated: check before acting</sub>`;

export function renderTriage(out, meta) {
  if (out.decision === 'needs-info') {
    return [
      MARKER,
      '### More information needed',
      '',
      list(out.questions),
      '',
      'Answer these by editing the issue description. Once finished, add the `scaffold:triage` label and this issue will be triaged again.',
      '',
      footer(meta),
    ].join('\n');
  }
  const parts = [
    MARKER,
    '### SCAFFOLD status',
    '',
    '| Gate | State |',
    '| --- | --- |',
    '| Triage | ✅ ready |',
    '| Plan | ⏳ pending |',
    '',
    '✅ **Triaged → ready.** A member can comment `/plan` (coming in slice 2).',
    '',
    `**Summary:** ${e(out.summary)}`,
    `**Type:** ${out.type} · **Suggested priority:** ${out.priority}`,
  ];
  const b = out.brief;
  parts.push('', '<details><summary>Agent-ready brief</summary>', '', `**Goal:** ${e(b.goal)}`);
  if (b.acceptance_criteria.length) parts.push('', '**Acceptance criteria**', list(b.acceptance_criteria));
  if (b.affected_areas.length) parts.push('', '**Likely affected areas**', list(b.affected_areas));
  if (b.out_of_scope.length) parts.push('', '**Out of scope**', list(b.out_of_scope));
  parts.push('', '</details>', '', footer(meta));
  return parts.join('\n');
}

export function renderNotice(text) {
  return [MARKER, '### SCAFFOLD status', '', text].join('\n');
}

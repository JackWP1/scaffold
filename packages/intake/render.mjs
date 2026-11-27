// Renders the SCAFFOLD status comment for triage. All model text is escaped.
import { escapeForComment as e } from '../core/lib/text.mjs';
import { MARKER, gateTable, manualStates } from '../core/lib/status.mjs';
import { stageOn } from '../core/lib/config.mjs';

export { MARKER };

const list = (items) => items.map((i) => `- ${e(i)}`).join('\n');

const footer = ({ skillVersion, model }) => `<sub>triage v${skillVersion} · ${model} · AI-generated: check before acting</sub>`;

// `config` decides how the plan stage is shown: with plan off, its rows are manual (PLAN.md section 5).
// `scenarios` ({ state, next }) is set when the issue needs approved scenarios before it is ready.
export function renderTriage(out, meta, { config, scenarios } = {}) {
  if (out.decision === 'needs-info' && !out.proposed_tickets?.length) {
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
  const planOn = stageOn(config, 'plan');
  const manual = manualStates(config);
  if (out.proposed_tickets?.length) {
    return [
      MARKER,
      '### SCAFFOLD status',
      '',
      gateTable({ ...manual, Triage: '🧱 too big: smaller tickets proposed', ...(planOn ? { Plan: '🧱 too big for one stack' } : {}) }),
      '',
      '**Next:** a member creates each proposed ticket as a new issue from the Request form, with its own Jira key, then closes this issue as split. To keep it as one ticket instead, narrow its scope and add the `scaffold:triage` label.',
      '',
      `**Summary:** ${e(out.summary)}`,
      '',
      '#### Proposed tickets',
      '',
      ...out.proposed_tickets.map((t, i) => `${i + 1}. **${e(t.title)}**: ${e(t.scope)}`),
      '',
      footer(meta),
    ].join('\n');
  }
  // With gherkin off, `manual` already shows the row as not used.
  const scenarioRow = config?.gherkin === 'off' ? {} : {
    Scenarios: scenarios?.state ?? (config?.gherkin === 'auto' ? '➖ not needed (triage decided; a member can add `scaffold:needs-gherkin`)' : '➖ not needed'),
  };
  const next = scenarios
    ? `**Next:** ${scenarios.next}`
    : planOn
      ? '**Next:** a member comments `/plan` to get a plan.'
      : '**Next:** plan by hand: see `packages/plan/HANDOFF.md`.';
  const parts = [
    MARKER,
    '### SCAFFOLD status',
    '',
    gateTable({
      ...manual,
      Triage: scenarios ? '✅ triaged: scenarios needed' : '✅ ready',
      ...scenarioRow,
      ...(planOn ? { Plan: scenarios ? '⏳ waiting for approved scenarios' : '⏳ waiting for `/plan`' } : {}),
    }),
    '',
    next,
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

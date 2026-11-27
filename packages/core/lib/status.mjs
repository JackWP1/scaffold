// The one SCAFFOLD status comment per issue (PLAN.md section 6): a gate table and a next step.
// Each stage updates its own rows, so earlier stages' rows and details are kept.
import { stageOn } from './config.mjs';

export const MARKER = '<!-- scaffold:status -->';
export const GATES = ['Triage', 'Scenarios', 'Plan', 'Approval'];
// The status rows each package owns. A package that is off shows its rows as manual.
export const STAGE_GATES = { intake: ['Triage', 'Scenarios'], plan: ['Plan', 'Approval'] };
export const SCENARIOS_OFF = '➖ not used (`gherkin: off`)';

const HEADER = '| Gate | State |\n| --- | --- |';

export const manual = (stage) => `✋ manual (\`${stage}\` stage off: see \`packages/${stage}/HANDOFF.md\`)`;
export const manualBefore = (stage) => `✋ manual (before \`${stage}\` was on)`;

// Row states for every package that `config` turns off, to merge into a stage's own states.
export function manualStates(config) {
  const states = {};
  for (const [stage, gates] of Object.entries(STAGE_GATES)) {
    if (!stageOn(config, stage)) for (const g of gates) states[g] = manual(stage);
  }
  if (config?.gherkin === 'off') states.Scenarios = SCENARIOS_OFF;
  return states;
}

export function gateTable(states) {
  return [HEADER, ...GATES.map((g) => `| ${g} | ${states[g] ?? '⏳ pending'} |`)].join('\n');
}

// Sets gate rows and the **Next:** line in an existing status body, adding the table if it is missing.
// `body` must only contain text SCAFFOLD wrote; states and next are trusted (built by Actions code).
export function setGates(body, states, next) {
  let out = body?.startsWith(MARKER) ? body : `${MARKER}\n### SCAFFOLD status`;
  if (!out.includes(HEADER)) out = out.replace(/^(### .*)$/m, (h) => `${h}\n\n${gateTable({})}`);
  // A status comment written before a gate existed gets its row, in GATES order.
  GATES.forEach((gate, i) => {
    if (new RegExp(`^\\| ${gate} \\| `, 'm').test(out)) return;
    const before = GATES.slice(0, i).reverse().find((g) => new RegExp(`^\\| ${g} \\| `, 'm').test(out));
    out = before
      ? out.replace(new RegExp(`^(\\| ${before} \\| .* \\|)$`, 'm'), (row) => `${row}\n| ${gate} | ⏳ pending |`)
      : out.replace(HEADER, () => `${HEADER}\n| ${gate} | ⏳ pending |`);
  });
  for (const [gate, state] of Object.entries(states)) {
    out = out.replace(new RegExp(`^\\| ${gate} \\| .* \\|$`, 'm'), () => `| ${gate} | ${state} |`);
  }
  if (next !== undefined) {
    const line = `**Next:** ${next}`;
    out = /^\*\*Next:\*\* .*$/m.test(out)
      ? out.replace(/^\*\*Next:\*\* .*$/m, () => line)
      : out.replace(/^\| Approval \| .* \|$/m, (row) => `${row}\n\n${line}`);
  }
  return out;
}

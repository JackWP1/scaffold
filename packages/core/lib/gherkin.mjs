// Gherkin for acceptance scenarios (PLAN.md section 2, Scenarios). Actions checks scenarios parse before
// posting them, and the scenarios check matches each one by tag and a hash of its normalised steps.
// Covers the subset scenarios use: one Feature, optional Background, Scenario / Scenario Outline with
// Examples, steps, doc strings, data tables, tags and comments. Not a general Gherkin parser.
import { createHash } from 'node:crypto';

const STEP = /^(Given|When|Then|And|But|\*)\s+(.+)$/;
const SCENARIO = /^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/;
const EXAMPLES = /^(Examples|Scenarios):\s*(.*)$/;
export const MAX_SCENARIOS = 20;

// The tag that ties scenario `n` of an issue to its `.feature` file (runner report contract).
export const scenarioTag = (issue, n) => `@scaffold-${issue}-S${n}`;

const squash = (s) => s.trim().replace(/\s+/g, ' ');
const tableRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(squash).join(' | ');

// Returns { feature, background, scenarios, errors }. Each scenario is { name, tags, steps, examples },
// where steps are normalised lines (keyword, text, then any doc string or table rows) and examples
// are normalised table rows. Errors name the 1-based line.
export function parseGherkin(text) {
  const out = { feature: null, background: [], scenarios: [], errors: [] };
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let section = null; // 'feature' | 'background' | 'scenario' | 'examples'
  let current = null;
  let tags = [];
  let doc = null; // { fence, start }
  const err = (i, msg) => out.errors.push(`line ${i + 1}: ${msg}`);
  const steps = () => (section === 'background' ? out.background : current.steps);

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (doc) {
      if (line === doc.fence) doc = null;
      else steps().push(`  ${raw.slice(doc.indent).trimEnd()}`);
      return;
    }
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('@')) {
      if (!/^(@[^\s@]+\s*)+$/.test(line)) return err(i, 'tags must be @words separated by spaces');
      tags.push(...line.split(/\s+/));
      return;
    }
    const feature = line.match(/^Feature:\s*(.*)$/);
    if (feature) {
      if (out.feature !== null) return err(i, 'only one Feature is allowed');
      out.feature = squash(feature[1]);
      section = 'feature';
      tags = [];
      return;
    }
    if (out.feature === null) return err(i, 'expected `Feature:` first');
    if (/^Background:/.test(line)) {
      if (out.scenarios.length || out.background.length) return err(i, 'Background must come once, before any scenario');
      section = 'background';
      return;
    }
    const scenario = line.match(SCENARIO);
    if (scenario) {
      current = { name: squash(scenario[2]), outline: scenario[1].startsWith('Scenario '), tags, steps: [], examples: [] };
      out.scenarios.push(current);
      section = 'scenario';
      tags = [];
      return;
    }
    if (EXAMPLES.test(line)) {
      if (!current?.outline) return err(i, 'Examples only belong to a Scenario Outline');
      section = 'examples';
      tags = [];
      return;
    }
    if (line.startsWith('|')) {
      if (section === 'examples') current.examples.push(tableRow(line));
      else if (['scenario', 'background'].includes(section) && steps().length) steps().push(`  | ${tableRow(line)} |`);
      else err(i, 'table outside a step or Examples');
      return;
    }
    if (line === '"""' || line === '```') {
      if (!['scenario', 'background'].includes(section) || !steps().length) return err(i, 'doc string outside a step');
      doc = { fence: line, indent: raw.indexOf(line) };
      return;
    }
    const step = line.match(STEP);
    if (step) {
      if (section === 'examples') return err(i, 'step after Examples: start a new scenario');
      if (!['scenario', 'background'].includes(section)) return err(i, 'step outside a scenario');
      steps().push(`${step[1]} ${squash(step[2])}`);
      return;
    }
    // Free text is only allowed as a description straight after a Feature or Scenario line.
    if (section === 'feature' || (section === 'scenario' && !current.steps.length)) return;
    err(i, `can't parse \`${line.slice(0, 60)}\``);
  });

  if (doc) out.errors.push('a doc string is not closed');
  if (out.feature === null && !out.errors.length) out.errors.push('no `Feature:`');
  if (out.feature !== null && !out.scenarios.length) out.errors.push('no scenarios');
  if (out.scenarios.length > MAX_SCENARIOS) out.errors.push(`more than ${MAX_SCENARIOS} scenarios`);
  for (const [n, s] of out.scenarios.entries()) {
    const which = `scenario ${n + 1}${s.name ? ` (${s.name})` : ''}`;
    if (!s.name) out.errors.push(`scenario ${n + 1} has no name`);
    if (!s.steps.some((l) => STEP.test(l))) out.errors.push(`${which} has no steps`);
    if (s.outline && s.examples.length < 2) out.errors.push(`${which} is an outline without an Examples table`);
  }
  for (const s of out.scenarios) delete s.outline;
  return out;
}

// Hash of a scenario's normalised steps and examples: what the approval covers. Whitespace and
// the scenario's name and tags don't change it; any step or example change does.
export function scenarioHash(scenario) {
  return createHash('sha256').update([...scenario.steps, '--', ...scenario.examples].join('\n')).digest('hex').slice(0, 16);
}

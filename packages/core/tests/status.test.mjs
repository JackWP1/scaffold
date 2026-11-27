import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER, setGates, manualStates, manual, SCENARIOS_OFF } from '../lib/status.mjs';
import { configFrom } from '../lib/config.mjs';

test('status gates add a table when there is none', () => {
  const body = setGates(undefined, { Plan: '⏸️ waiting' }, 'wait.');
  assert.ok(body.startsWith(MARKER));
  assert.ok(body.includes('| Triage | ⏳ pending |\n| Scenarios | ⏳ pending |\n| Plan | ⏸️ waiting |\n| Approval | ⏳ pending |\n| Conflicts | ⏳ pending |\n\n**Next:** wait.'));
});

test('status gates replace a row with text containing $ patterns', () => {
  const body = setGates(undefined, { Plan: 'a' });
  assert.ok(setGates(body, { Plan: 'x $& y' }).includes('| Plan | x $& y |'));
});

test('stages that are off show as manual rows', () => {
  const bdd = 'bdd:\n  workflow: ci.yml\n  artifact: r';
  const collab = 'collaboration: true';
  assert.deepEqual(manualStates(configFrom(`stages:\n  intake: true\n  plan: true\n  ${collab}\ngherkin: auto\n${bdd}`)), {});
  assert.deepEqual(manualStates(configFrom(`stages:\n  plan: true\n  ${collab}\ngherkin: auto\n${bdd}`)), { Triage: manual('intake'), Scenarios: manual('intake') });
  assert.deepEqual(Object.keys(manualStates(configFrom('stages:\n  intake: true'))), ['Plan', 'Approval', 'Conflicts', 'Scenarios']);
  assert.match(manual('plan'), /manual \(`plan` stage off: see `packages\/plan\/HANDOFF.md`\)/);
});

test('scenarios off shows its row as not used, whatever the stages', () => {
  assert.deepEqual(manualStates(configFrom('stages:\n  intake: true\n  plan: true')), { Conflicts: manual('collaboration'), Scenarios: SCENARIOS_OFF });
  assert.equal(manualStates(configFrom('')).Scenarios, SCENARIOS_OFF);
});

test('a status comment from before the Scenarios gate gets its row', () => {
  const old = `${MARKER}\n### SCAFFOLD status\n\n| Gate | State |\n| --- | --- |\n| Triage | ✅ ready |\n| Plan | 📝 planned |\n| Approval | ⏳ pending |\n\n**Next:** x`;
  const body = setGates(old, { Scenarios: '✅ approved' });
  assert.ok(body.includes('| Triage | ✅ ready |\n| Scenarios | ✅ approved |\n| Plan | 📝 planned |'));
});

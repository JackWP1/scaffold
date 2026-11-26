import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER, setGates, manualStates, manual } from '../lib/status.mjs';
import { configFrom } from '../lib/config.mjs';

test('status gates add a table when there is none', () => {
  const body = setGates(undefined, { Plan: '⏸️ waiting' }, 'wait.');
  assert.ok(body.startsWith(MARKER));
  assert.ok(body.includes('| Triage | ⏳ pending |\n| Plan | ⏸️ waiting |\n| Approval | ⏳ pending |\n\n**Next:** wait.'));
});

test('status gates replace a row with text containing $ patterns', () => {
  const body = setGates(undefined, { Plan: 'a' });
  assert.ok(setGates(body, { Plan: 'x $& y' }).includes('| Plan | x $& y |'));
});

test('stages that are off show as manual rows', () => {
  assert.deepEqual(manualStates(configFrom('stages:\n  intake: true\n  plan: true')), {});
  assert.deepEqual(manualStates(configFrom('stages:\n  plan: true')), { Triage: manual('intake') });
  assert.deepEqual(Object.keys(manualStates(configFrom('stages:\n  intake: true'))), ['Plan', 'Approval']);
  assert.match(manual('plan'), /manual \(`plan` stage off: see `packages\/plan\/HANDOFF.md`\)/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseLabels } from '../lib/labels.mjs';

const ROOT = new URL('../../../', import.meta.url);
const labels = parseLabels(await readFile(new URL('packages/core/config/labels.yml', ROOT), 'utf8'));

test('labels config parses with every scaffold label', () => {
  assert.equal(labels.length, 21);
  assert.deepEqual(labels[0], { name: 'scaffold:triage', color: 'ededed', description: 'SCAFFOLD is triaging this issue' });
  assert.ok(labels.every((l) => /^[0-9a-f]{6}$/.test(l.color)));
});

test('label colours match the PLAN.md section 2 table', async () => {
  const plan = await readFile(new URL('PLAN.md', ROOT), 'utf8');
  const spec = {};
  for (const row of plan.matchAll(/^\|.*\| (`[^|]+`) \| `([0-9a-f]{6})` .*\|$/gm)) {
    for (const [, name] of row[1].matchAll(/`([^`]+)`/g)) spec[name] = row[2];
  }
  assert.deepEqual(Object.fromEntries(labels.map((l) => [l.name, l.color])), spec);
});

// Every scaffold:* label a package applies or removes must exist, so a typo can't create a stray label.
test('every scaffold label named in package code is in labels.yml', async () => {
  const { readdir } = await import('node:fs/promises');
  const names = new Set(labels.map((l) => l.name));
  const unknown = new Set();
  for (const f of await readdir(new URL('packages/', ROOT), { recursive: true })) {
    if (!f.endsWith('.mjs') || f.includes('/tests/')) continue;
    const src = await readFile(new URL(`packages/${f}`, ROOT), 'utf8');
    for (const [name] of src.matchAll(/scaffold:[a-z-]+(?=['`\s,\]])/g)) {
      if (!['scaffold:status', 'scaffold:plan', 'scaffold:plan-data', 'scaffold:usage-report', 'scaffold:scenarios', 'scaffold:plan-scenarios', 'scaffold:rework', 'scaffold:code-review', 'scaffold:code-review-run', 'scaffold:ci-diagnosis', 'scaffold:conflict-check-2'].includes(name) && !names.has(name)) unknown.add(`${f}: ${name}`);
    }
  }
  assert.deepEqual([...unknown], []);
});

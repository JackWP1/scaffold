import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));

// Relative module imports and package files loaded by URL, as { file, from, target } (paths under packages/).
async function references() {
  const found = [];
  for (const f of await readdir(PACKAGES, { recursive: true })) {
    if (!f.endsWith('.mjs')) continue;
    const src = await readFile(join(PACKAGES, f), 'utf8');
    const add = (spec, kind) => found.push({ file: f, from: f.split(sep)[0], target: relative(PACKAGES, join(dirname(join(PACKAGES, f)), spec)), kind });
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)\s[^'"]*?['"](\.{1,2}\/[^'"]+)['"]/gm)) add(spec, 'import');
    for (const [, spec] of src.matchAll(/import\(\s*['"](\.{1,2}\/[^'"]+)['"]/g)) add(spec, 'import');
    for (const [, spec] of src.matchAll(/new URL\(\s*['"](\.{1,2}\/[^'"]+)['"],\s*import\.meta\.url/g)) add(spec, 'url');
  }
  return found;
}

// A package may use itself and core; core only itself. Modules never come from outside packages/;
// files read by URL may (tests read PLAN.md and the caller templates).
export function violates({ from, target, kind }) {
  const to = target.split(sep)[0];
  if (to === '..') return kind === 'import';
  if (to === '') return kind === 'import'; // packages/ itself, e.g. this scan's root
  return to !== from && to !== 'core';
}

test('packages import only from themselves and core; core imports only from core (PLAN.md section 5)', async () => {
  const all = await references();
  assert.ok(all.filter((r) => r.kind === 'import').length > 30, 'the scan finds imports');
  assert.deepEqual(all.filter(violates).map(({ file, target }) => `${file} -> ${target}`), []);
});

test('the import rule catches cross-package and outside imports', () => {
  assert.equal(violates({ from: 'plan', target: join('intake', 'triage.mjs'), kind: 'import' }), true);
  assert.equal(violates({ from: 'core', target: join('plan', 'rules.mjs'), kind: 'import' }), true);
  assert.equal(violates({ from: 'plan', target: join('..', 'scripts', 'x.mjs'), kind: 'import' }), true);
  assert.equal(violates({ from: 'plan', target: join('core', 'lib', 'issue.mjs'), kind: 'import' }), false);
  assert.equal(violates({ from: 'plan', target: join('plan', 'rules.mjs'), kind: 'import' }), false);
  assert.equal(violates({ from: 'core', target: join('..', 'PLAN.md'), kind: 'url' }), false);
});

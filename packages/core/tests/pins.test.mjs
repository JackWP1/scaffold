import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';

const ROOT = new URL('../../../', import.meta.url);
const dirs = ['.github/workflows/', 'templates/caller/.github/workflows/'];

async function usesRefs() {
  const refs = [];
  for (const dir of dirs) {
    for (const file of await readdir(new URL(dir, ROOT))) {
      const yaml = await readFile(new URL(`${dir}${file}`, ROOT), 'utf8');
      for (const [, ref] of yaml.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) refs.push({ where: `${dir}${file}`, ref });
    }
  }
  return refs;
}

test('every external uses: is pinned to a full commit SHA', async () => {
  const unpinned = (await usesRefs()).filter(({ ref }) => !ref.startsWith('./') && !/@[0-9a-f]{40}$/.test(ref));
  assert.deepEqual(unpinned, []);
});

// A release pins these to a SHA; the path must exist at HEAD so the release pins something real.
test('every internal uses: path exists at HEAD', async () => {
  const missing = [];
  for (const { where, ref } of await usesRefs()) {
    const m = ref.match(/^JackWP1\/scaffold\/([^@]+)@/);
    if (!m) continue;
    const path = m[1];
    const file = path.endsWith('.yml') ? path : `${path}/action.yml`;
    try {
      await stat(new URL(file, ROOT));
    } catch {
      missing.push(`${where}: ${path}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('no internal uses: points at the old actions/ layout', async () => {
  assert.deepEqual((await usesRefs()).filter(({ ref }) => /^JackWP1\/scaffold\/actions\//.test(ref)), []);
});

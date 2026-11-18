import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const dirs = ['../.github/workflows/', '../templates/caller/.github/workflows/'];

test('every external uses: is pinned to a full commit SHA', async () => {
  const unpinned = [];
  for (const dir of dirs) {
    const url = new URL(dir, import.meta.url);
    for (const file of await readdir(url)) {
      const yaml = await readFile(new URL(file, url), 'utf8');
      for (const [, ref] of yaml.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) {
        if (!ref.startsWith('./') && !/@[0-9a-f]{40}$/.test(ref)) unpinned.push(`${dir}${file}: ${ref}`);
      }
    }
  }
  assert.deepEqual(unpinned, []);
});

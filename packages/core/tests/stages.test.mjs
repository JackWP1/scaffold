import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageOnSince, enteredBefore, MAX_HISTORY } from '../lib/stages.mjs';
import { fakeGh } from './fake-github.mjs';

// `versions` are scaffold-config.yml bodies, newest first; null is a commit that deleted the file.
function historyGh(versions) {
  const commits = versions.map((_, i) => ({ sha: `s${i}`, commit: { committer: { date: `2026-11-${String(20 - i).padStart(2, '0')}T00:00:00Z` } } }));
  return fakeGh({
    '/repos/o/r/commits': commits,
    '/repos/o/r/contents/.github/scaffold-config.yml': (path) => {
      const body = versions[Number(path.match(/ref=s(\d+)/)[1])];
      if (body === null) throw new Error('GET: 404 Not Found');
      return { content: Buffer.from(body).toString('base64') };
    },
  });
}

test('a stage is on since the oldest commit in its latest run of commits with it on', async () => {
  const on = 'stages:\n  plan: true';
  assert.equal(await stageOnSince(historyGh([on, on, 'stages:\n  plan: false', on]), 'o/r', 'plan'), '2026-11-19T00:00:00Z');
  assert.equal(await stageOnSince(historyGh([on, 'max_in_flight: foo']), 'o/r', 'plan'), '2026-11-20T00:00:00Z');
  assert.equal(await stageOnSince(historyGh([on, on]), 'o/r', 'plan'), '2026-11-19T00:00:00Z');
  assert.equal(await stageOnSince(historyGh(['stages:\n  plan: false']), 'o/r', 'plan'), null);
});

test('with every commit checked on and more history possible, gates apply to every issue', async () => {
  assert.equal(await stageOnSince(historyGh(Array(MAX_HISTORY).fill('stages:\n  plan: true')), 'o/r', 'plan'), null);
});

test('an issue entered a stage before it was on if its entry label is older', () => {
  const ev = (at) => ({ event: 'labeled', label: { name: 'scaffold:planned' }, created_at: at });
  assert.equal(enteredBefore([ev('2026-11-01T00:00:00Z')], 'scaffold:planned', '2026-11-10T00:00:00Z'), true);
  assert.equal(enteredBefore([ev('2026-11-01T00:00:00Z'), ev('2026-11-11T00:00:00Z')], 'scaffold:planned', '2026-11-10T00:00:00Z'), false);
  assert.equal(enteredBefore([], 'scaffold:planned', '2026-11-10T00:00:00Z'), false);
  assert.equal(enteredBefore([ev('2026-11-01T00:00:00Z')], 'scaffold:planned', null), false);
});

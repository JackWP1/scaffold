import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueSteps } from '../actions/triage/steps.mjs';
import { MARKER } from '../actions/triage/render.mjs';

// Fake client: `routes` maps a path prefix to a response (or a function of the path).
function fakeGh(routes = {}) {
  const calls = [];
  const respond = (method, path, body) => {
    calls.push([method, path, body]);
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const r = routes[key];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(path) : r ?? null;
  };
  return {
    calls,
    get: async (p) => respond('GET', p),
    post: async (p, b) => respond('POST', p, b),
    patch: async (p, b) => respond('PATCH', p, b),
    delete: async (p) => respond('DELETE', p),
    async *pages(p) {
      for (let page = 1; ; page++) {
        const items = respond('GET', `${p}?page=${page}`);
        yield items;
        if (items.length < 100) return;
      }
    },
  };
}

const page = (n, fill) => Array.from({ length: n }, fill);
const bot = { login: 'github-actions[bot]' };

test('setLabels removes a label added earlier in the run', async () => {
  const gh = fakeGh();
  const labels = ['bug'];
  const { setLabels } = issueSteps(gh, 'o/r', 1, labels);
  await setLabels(['scaffold:triage'], ['scaffold:triage', 'scaffold:ready']);
  await setLabels(['scaffold:ready'], ['scaffold:triage', 'scaffold:ready']);
  assert.deepEqual(labels, ['bug', 'scaffold:ready']);
  assert.ok(gh.calls.some(([m, p]) => m === 'DELETE' && p.endsWith('/labels/scaffold%3Atriage')));
});

test('upsertStatus finds the status comment on a later page', async () => {
  const gh = fakeGh({
    '/repos/o/r/issues/1/comments': (p) => p.endsWith('page=1')
      ? page(100, (_, i) => ({ id: i, user: { login: 'someone' }, body: 'hi' }))
      : [{ id: 999, user: bot, body: `${MARKER}\nold` }],
  });
  await issueSteps(gh, 'o/r', 1, []).upsertStatus('new');
  assert.deepEqual(gh.calls.at(-1), ['PATCH', '/repos/o/r/issues/comments/999', { body: 'new' }]);
  assert.ok(!gh.calls.some(([m]) => m === 'POST'));
});

test('upsertStatus posts once all pages are checked', async () => {
  const gh = fakeGh({ '/repos/o/r/issues/1/comments': [] });
  await issueSteps(gh, 'o/r', 1, []).upsertStatus('new');
  assert.deepEqual(gh.calls.at(-1), ['POST', '/repos/o/r/issues/1/comments', { body: 'new' }]);
});

const perm = (permission) => ({ '/repos/o/r/collaborators/': permission instanceof Error ? permission : { permission } });
const user = { login: 'alice', type: 'User' };

test('acceptance by a user with write access is trusted', async () => {
  assert.equal(await issueSteps(fakeGh(perm('write')), 'o/r', 1, []).acceptedByMember(user), true);
  assert.equal(await issueSteps(fakeGh(perm('admin')), 'o/r', 1, []).acceptedByMember(user), true);
});

test('acceptance by a read-only user, a bot or an unknown user is not trusted', async () => {
  assert.equal(await issueSteps(fakeGh(perm('read')), 'o/r', 1, []).acceptedByMember(user), false);
  assert.equal(await issueSteps(fakeGh(perm('write')), 'o/r', 1, []).acceptedByMember({ login: 'x[bot]', type: 'Bot' }), false);
  assert.equal(await issueSteps(fakeGh(perm(new Error('404'))), 'o/r', 1, []).acceptedByMember(user), false);
});

test('without a sender, the latest scaffold:accepted labeler is checked', async () => {
  const gh = fakeGh({
    '/repos/o/r/issues/1/events': [
      { event: 'labeled', label: { name: 'scaffold:accepted' }, actor: { login: 'mallory', type: 'User' } },
      { event: 'labeled', label: { name: 'bug' }, actor: { login: 'bob', type: 'User' } },
      { event: 'labeled', label: { name: 'scaffold:accepted' }, actor: user },
    ],
    ...perm('maintain'),
  });
  assert.equal(await issueSteps(gh, 'o/r', 1, []).acceptedByMember(), true);
  assert.equal(gh.calls.at(-1)[1], '/repos/o/r/collaborators/alice/permission');
});

test('without a sender or a labeled event, acceptance is not trusted', async () => {
  const gh = fakeGh({ '/repos/o/r/issues/1/events': [], ...perm('admin') });
  assert.equal(await issueSteps(gh, 'o/r', 1, []).acceptedByMember(), false);
});

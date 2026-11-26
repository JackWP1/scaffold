import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuard } from '../actions/config-guard/guard.mjs';
import { fakeGh } from './fake-github.mjs';

const BASE = 'approvers: [alice, bob]\nmax_in_flight: 10\nflow_lead: bob';
const pr = { number: 3, user: { login: 'carol' }, base: { sha: 'base' }, head: { sha: 'head' } };
const review = (login, state = 'APPROVED', commit = 'head') => ({ user: { login, type: 'User' }, state, commit_id: commit });

function guard({ base = BASE, head, files = ['.github/scaffold-config.yml'], reviews = [] }) {
  const file = (body) => {
    if (body === null) throw new Error('GET: 404 Not Found');
    return { content: Buffer.from(body).toString('base64') };
  };
  const gh = fakeGh({
    '/repos/o/r/pulls/3/files': files.map((filename) => ({ filename })),
    '/repos/o/r/pulls/3/reviews': reviews,
    '/repos/o/r/contents/.github/scaffold-config.yml': (path) => file(path.includes('ref=head') ? head : base),
  });
  return runGuard(gh, 'o/r', { pr });
}

test('passes when the PR does not touch scaffold-config.yml', async () => {
  const r = await guard({ files: ['src/a.js'], head: 'max_in_flight: nope' });
  assert.equal(r.ok, true);
  assert.match(r.outcome, /unchanged/);
});

test('fails an invalid file at the PR head', async () => {
  const r = await guard({ head: 'max_in_flight: nope' });
  assert.equal(r.ok, false);
  assert.match(r.outcome, /invalid: \$.max_in_flight: expected integer/);
});

test('an unprotected change (flow_lead) needs no approver', async () => {
  assert.equal((await guard({ head: BASE.replace('flow_lead: bob', 'flow_lead: alice') })).ok, true);
});

test('a protected change needs a listed approver from the base branch who is not the author', async () => {
  const head = BASE.replace('max_in_flight: 10', 'max_in_flight: 50');
  const none = await guard({ head });
  assert.equal(none.ok, false);
  assert.match(none.outcome, /changes `max_in_flight`: needs an approving review/);
  assert.equal((await guard({ head, reviews: [review('Alice')] })).ok, true);
  assert.equal((await guard({ head, reviews: [review('alice', 'APPROVED', 'old')] })).ok, false, 'stale approval');
  assert.equal((await guard({ head, reviews: [review('alice'), review('alice', 'DISMISSED')] })).ok, false, 'dismissed');
  assert.equal((await guard({ head, reviews: [review('alice'), { ...review('alice'), state: 'COMMENTED' }] })).ok, true, 'comment keeps approval');
  assert.equal((await guard({ head, reviews: [review('mallory')] })).ok, false, 'unlisted');
});

test('a PR cannot approve itself by adding its author or reviewer as an approver', async () => {
  const head = 'approvers: [alice, bob, mallory]\nmax_in_flight: 10\nflow_lead: bob';
  const r = await guard({ head, reviews: [review('mallory')] });
  assert.equal(r.ok, false);
  assert.match(r.outcome, /changes `approvers`/);
  const author = await guard({ base: 'approvers: [carol]', head: 'approvers: [carol]\nmax_stack_prs: 3', reviews: [review('carol')] });
  assert.equal(author.ok, false, 'author approving own PR');
});

test('turning a stage on or off is protected', async () => {
  const r = await guard({ base: `${BASE}\nstages:\n  plan: true`, head: `${BASE}\nstages:\n  plan: false` });
  assert.match(r.outcome, /changes `stages`/);
  assert.equal(r.ok, false);
});

test('with no approvers on the base branch (first install) the change passes on code-owner review', async () => {
  const r = await guard({ base: null, head: BASE });
  assert.equal(r.ok, true);
  assert.match(r.outcome, /No approvers are listed on the base branch/);
});

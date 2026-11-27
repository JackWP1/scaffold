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

test('ci_workflows is protected: changing it needs a listed approver', async () => {
  const r = await guard({ head: `${BASE}\nci_workflows: [deploy.yml]` });
  assert.equal(r.ok, false);
  assert.match(r.outcome, /changes `ci_workflows`/);
  assert.equal((await guard({ head: `${BASE}\nci_workflows: [deploy.yml]`, reviews: [review('alice')] })).ok, true);
});

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

test('the latest review wins whatever order the API returns them in', async () => {
  const head = 'approvers: [alice, bob]\nmax_in_flight: 5\nflow_lead: bob';
  const at = (r, id, submitted_at) => ({ ...r, id, submitted_at });
  const approve = at(review('alice'), 1, '2026-11-20T10:00:00Z');
  const block = at(review('alice', 'CHANGES_REQUESTED'), 2, '2026-11-20T11:00:00Z');
  assert.equal((await guard({ head, reviews: [block, approve] })).ok, false, 'newest first');
  assert.equal((await guard({ head, reviews: [approve, block] })).ok, false, 'oldest first');
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

test('an invalid base file fails closed: any change needs an approver read from the raw file', async () => {
  const base = 'approvers: [alice]\nmax_in_flight: nope';
  const head = 'approvers: [carol]\nmax_in_flight: 10';
  const none = await guard({ base, head });
  assert.equal(none.ok, false);
  assert.match(none.outcome, /invalid on the base branch/);
  assert.match(none.lines.join('\n'), /Listed approvers \(base branch\): `alice`/);
  assert.equal((await guard({ base, head, reviews: [review('carol')] })).ok, false);
  const ok = await guard({ base, head, reviews: [review('alice')] });
  assert.equal(ok.ok, true);
  assert.match(ok.outcome, /approved by `alice`/);
});

test('an invalid base file with no usable approvers fails for an admin to fix', async () => {
  for (const base of ['max_in_flight: nope', 'approvers: [not a login]\nmax_in_flight: nope', 'approvers: nope: nope']) {
    const r = await guard({ base, head: 'approvers: [carol]', reviews: [review('alice')] });
    assert.equal(r.ok, false, base);
    assert.match(r.outcome, /no valid `approvers` list .* repo admin must fix/, base);
  }
});

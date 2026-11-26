import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkApproval, commentHash } from '../lib/approval.mjs';

const applied = (login, at = '2026-11-18T12:00:00Z', type = 'User') => ({ id: 7, event: 'labeled', label: { name: 'x:approved' }, actor: { login, type }, created_at: at });
const comment = { body: 'thing', updated_at: '2026-11-18T11:00:00Z' };
const check = (over) => checkApproval({ events: [applied('Alice')], label: 'x:approved', author: 'carol', approvers: ['alice'], comment, what: 'thing', ...over });

test('timeline approval passes for a listed approver after the comment last changed', () => {
  assert.deepEqual(check({}), { ok: true, approver: 'Alice', at: '2026-11-18T12:00:00Z', eventId: 7, hash: commentHash('thing') });
});

test('timeline approval fails for the author, a bot, an unlisted user, no label or a later edit', () => {
  assert.match(check({ author: 'ALICE' }).reason, /author can't approve/);
  assert.match(check({ events: [applied('alice', undefined, 'Bot')] }).reason, /bot/);
  assert.match(check({ approvers: [] }).reason, /not a listed approver/);
  assert.match(check({ events: [] }).reason, /`x:approved` was not applied/);
  assert.match(check({ comment: { ...comment, updated_at: '2026-11-18T12:00:01Z' } }).reason, /the thing changed after it was approved/);
  assert.equal(check({ comment: undefined }).reason, 'there is no thing');
  assert.equal(check({ comment: undefined, missing: 'none yet' }).reason, 'none yet');
});

test('timeline approval uses the latest event applying the label', () => {
  assert.equal(check({ events: [applied('alice'), applied('mallory')] }).ok, false);
  assert.equal(check({ events: [applied('mallory'), applied('alice')] }).ok, true);
});

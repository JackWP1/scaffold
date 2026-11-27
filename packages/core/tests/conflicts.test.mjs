import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictState } from '../lib/conflicts.mjs';

const bot = { login: 'github-actions[bot]', type: 'Bot' };
const person = (login) => ({ login, type: 'User' });
let id = 0;
const ev = (event, name, actor, at) => ({ id: ++id, event, label: { name }, actor, created_at: at });
const flag = (at = '2026-11-20T10:00:00Z') => ev('labeled', 'scaffold:conflict', bot, at);
const resolve = (login, at) => ev('labeled', 'scaffold:conflict-resolved', person(login), at);
const state = (events) => conflictState({ events, approvers: ['alice'] });

test('no flag: no conflict; a flag stays open until a listed approver resolves it after the flag', () => {
  assert.equal(state([]).open, false);
  assert.equal(state([flag()]).open, true);
  assert.deepEqual(state([flag(), resolve('alice', '2026-11-20T11:00:00Z')]), { open: false, flaggedAt: '2026-11-20T10:00:00Z', resolvedBy: 'alice' });
  assert.match(state([flag(), resolve('mallory', '2026-11-20T11:00:00Z')]).reason, /not a listed approver/);
});

test('a resolution before the latest flag, a removed resolution, or removing the flag by hand don\'t clear it', () => {
  assert.equal(state([flag('2026-11-20T10:00:00Z'), resolve('alice', '2026-11-20T11:00:00Z'), flag('2026-11-20T12:00:00Z')]).open, true);
  assert.equal(state([flag(), resolve('alice', '2026-11-20T11:00:00Z'), ev('unlabeled', 'scaffold:conflict-resolved', person('bob'), '2026-11-20T12:00:00Z')]).open, true);
  assert.equal(state([flag(), ev('unlabeled', 'scaffold:conflict', person('bob'), '2026-11-20T11:00:00Z')]).open, true);
  assert.equal(state([ev('labeled', 'scaffold:conflict', person('bob'), '2026-11-20T10:00:00Z')]).open, false, 'only SCAFFOLD flags');
});

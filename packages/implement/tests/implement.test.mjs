// The implement package on its own: plan and intake are off or their state is a manual handoff's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configFrom } from '../../core/lib/config.mjs';
import { MARKER } from '../../core/lib/status.mjs';
import { fakeGh } from '../../core/tests/fake-github.mjs';
import { planGate, sizeCheck } from '../checks.mjs';
import { runImplementCheck, writeStatus, runSizeCommand, PR_GATES } from '../run.mjs';

const PLAN_ON = configFrom('stages:\n  plan: true\n  implement: true\napprovers: [alice]');
const PLAN_OFF = configFrom('stages:\n  implement: true\napprovers: [alice]');
const pr = { number: 4, body: 'Fixes #7', user: { login: 'Copilot' }, base: { sha: 'base' }, head: { sha: 'head' } };
const label = (name, login = 'alice', at = '2026-11-20T12:00:00Z', event = 'labeled') => ({ id: Date.parse(at) / 1000, event, label: { name }, actor: { login, type: 'User' }, created_at: at });
const bot = { login: 'github-actions[bot]' };

function gh({ issueLabels = ['scaffold:plan-approved'], issueEvents = [label('scaffold:plan-approved')], plans = [{ user: bot, body: '<!-- scaffold:plan -->\nplan', updated_at: '2026-11-20T11:00:00Z' }], prLabels = [], prEvents = [], prComments = [], files = [] } = {}) {
  return fakeGh({
    '/repos/o/r/issues/comments/': {},
    '/repos/o/r/issues/7/comments': plans,
    '/repos/o/r/issues/7/events': issueEvents,
    '/repos/o/r/issues/7': { number: 7, user: { login: 'carol' }, labels: issueLabels.map((name) => ({ name })) },
    '/repos/o/r/issues/4/comments': (path) => (path.includes('page=') ? prComments : {}),
    '/repos/o/r/issues/4/events': prEvents,
    '/repos/o/r/issues/4': { number: 4, labels: prLabels.map((name) => ({ name })) },
    '/repos/o/r/pulls/4/files': files,
    '/repos/o/r/contents/.github/scaffold-config.yml': { content: Buffer.from('stages:\n  plan: true\n  implement: true\napprovers: [alice]').toString('base64') },
  });
}

test('plan gate: passes a valid approval of an unchanged plan', async () => {
  const r = await planGate({ gh: gh(), repo: 'o/r', pr, config: PLAN_ON });
  assert.equal(r.ok, true, r.outcome);
  assert.match(r.row, /✅ #7, approved by `alice`/);
});

test('plan gate: fails without a link, label, valid approver or unchanged plan', async () => {
  const cases = [
    [{}, { ...pr, body: 'no link' }, /doesn't link an issue/],
    [{ issueLabels: ['scaffold:planned'] }, pr, /#7 has no approved plan/],
    [{ issueEvents: [label('scaffold:plan-approved', 'carol')] }, pr, /the issue author can't approve/],
    [{ issueEvents: [label('scaffold:plan-approved'), label('scaffold:plan-approved', 'bob', '2026-11-20T13:00:00Z', 'unlabeled')] }, pr, /was removed after it was applied/],
    [{ plans: [{ user: bot, body: '<!-- scaffold:plan -->\nedited', updated_at: '2026-11-20T13:00:00Z' }] }, pr, /the plan changed after it was approved/],
    [{ plans: [] }, pr, /#7 has no plan comment/],
  ];
  for (const [opts, p, reason] of cases) {
    const r = await planGate({ gh: gh(opts), repo: 'o/r', pr: p, config: PLAN_ON });
    assert.equal(r.ok, false, String(reason));
    assert.match(r.outcome, reason);
  }
});

test('plan gate: with plan on, a member\'s hand-written plan comment doesn\'t count', async () => {
  const r = await planGate({ gh: gh({ plans: [{ user: { login: 'dave' }, author_association: 'MEMBER', body: '<!-- scaffold:plan -->\nby hand', updated_at: '2026-11-20T11:00:00Z' }] }), repo: 'o/r', pr, config: PLAN_ON });
  assert.equal(r.ok, false);
  assert.match(r.outcome, /#7 has no plan comment/);
});

test('plan gate: with plan off, only that a listed approver applied the label', async () => {
  const r = await planGate({ gh: gh({ plans: [] }), repo: 'o/r', pr, config: PLAN_OFF });
  assert.equal(r.ok, true, r.outcome);
  assert.match(r.outcome, /plan stage off: label checked only/);
  assert.equal((await planGate({ gh: gh({ plans: [], issueEvents: [label('scaffold:plan-approved', 'mallory')] }), repo: 'o/r', pr, config: PLAN_OFF })).ok, false);
});

test('plan gate: required scenarios must still be approved', async () => {
  const always = configFrom('stages:\n  plan: true\n  implement: true\napprovers: [alice]\ngherkin: always\nbdd:\n  workflow: ci.yml\n  artifact: r');
  const r = await planGate({ gh: gh(), repo: 'o/r', pr, config: always });
  assert.equal(r.ok, false);
  assert.match(r.outcome, /#7's scenarios aren't approved: `scaffold:gherkin-approved` was not applied/);
});

const files = (n, lines = 10) => Array.from({ length: n }, (_, i) => ({ filename: `src/f${i}.js`, status: 'modified', additions: lines, deletions: 0 }));

test('PR size: within the soft limit passes; over it needs a valid exception', async () => {
  const within = await sizeCheck({ gh: gh(), repo: 'o/r', pr, files: files(10, 100), config: PLAN_ON });
  assert.equal(within.ok, true);
  assert.equal(within.row, '✅ 10 files / 1000 lines');
  const over = await sizeCheck({ gh: gh(), repo: 'o/r', pr, files: files(11), config: PLAN_ON });
  assert.equal(over.ok, false);
  assert.match(over.outcome, /11 files \/ 110 lines is over the soft limit \(10 files \/ 1000 lines\)/);
  assert.match(over.details[0], /\/size-exception <reason>/);
  const request = { body: '/size-exception generated | fixtures', author_association: 'MEMBER', created_at: '2026-11-20T11:00:00Z' };
  const granted = await sizeCheck({
    gh: gh({ prLabels: ['scaffold:size-exception'], prEvents: [label('scaffold:size-exception')], prComments: [request] }),
    repo: 'o/r', pr, files: files(11), config: PLAN_ON,
  });
  assert.equal(granted.ok, true, granted.outcome);
  assert.equal(granted.row, '✅ 11 files / 110 lines: exception by `alice`: generated \\| fixtures');
  const byAuthor = await sizeCheck({ gh: gh({ prLabels: ['scaffold:size-exception'], prEvents: [label('scaffold:size-exception', 'Copilot')], prComments: [request] }), repo: 'o/r', pr, files: files(11), config: PLAN_ON });
  assert.match(byAuthor.outcome, /isn't valid: the issue author can't approve/);
  const unasked = await sizeCheck({ gh: gh({ prLabels: ['scaffold:size-exception'], prEvents: [label('scaffold:size-exception')] }), repo: 'o/r', pr, files: files(11), config: PLAN_ON });
  assert.match(unasked.outcome, /was applied but nobody asked for one/);
  const early = await sizeCheck({ gh: gh({ prLabels: ['scaffold:size-exception'], prEvents: [label('scaffold:size-exception')], prComments: [{ ...request, created_at: '2026-11-20T13:00:00Z' }] }), repo: 'o/r', pr, files: files(11), config: PLAN_ON });
  assert.match(early.outcome, /changed after it was approved/, 'the label must come after the request');
  const breaker = await sizeCheck({ gh: gh({ prLabels: ['scaffold:size-exception', 'scaffold:escalate'], prEvents: [label('scaffold:escalate', 'github-actions[bot]', '2026-11-20T11:00:00Z'), label('scaffold:size-exception')] }), repo: 'o/r', pr, files: files(11), config: PLAN_ON });
  assert.equal(breaker.ok, true, breaker.outcome);
  assert.match(breaker.row, /circuit breaker tripped/);
  const hard = await sizeCheck({ gh: gh({ prLabels: ['scaffold:size-exception'], prEvents: [label('scaffold:size-exception')] }), repo: 'o/r', pr, files: files(31), config: PLAN_ON });
  assert.equal(hard.ok, false, 'an exception never lifts the hard limit');
});

test('runImplementCheck reads config from the base commit; status rows go in the PR status comment', async () => {
  const g = gh({ files: files(2) });
  const r = await runImplementCheck(g, 'o/r', { check: 'scaffold-pr-size', pr });
  assert.equal(r.ok, true);
  assert.ok(g.calls.some(([, p]) => p.includes('scaffold-config.yml?ref=base')));
  const s = gh();
  const states = await writeStatus(s, 'o/r', { pr, rows: { 'Plan gate': '✅ #7', Size: '' } });
  assert.deepEqual(states, { 'Plan gate': '✅ #7', Size: '⚠️ check didn\'t finish: re-run it', 'Work in progress': '➖ no developer assigned' });
  const body = s.calls.filter(([m]) => m === 'POST').at(-1)[2].body;
  assert.ok(body.startsWith(MARKER));
  assert.ok(body.includes(`| Plan gate | ✅ #7 |\n| Size | ⚠️ check didn't finish: re-run it |\n| Review gate | ⏳ pending |\n| Rework | ⏳ pending |\n| Work in progress | ➖ no developer assigned |\n\n**Next:** fix the failing rows (Size)`));
  assert.deepEqual(PR_GATES, ['Plan gate', 'Size', 'Review gate', 'Rework', 'Work in progress']);
});

test('/size-exception: members record a reason for a listed approver; others are refused', async () => {
  const event = (body, association = 'MEMBER', issue = { number: 4, pull_request: {} }) => ({ action: 'created', issue, comment: { id: 9, body, author_association: association, user: { login: 'dev', type: 'User' } } });
  const g = gh();
  const r = await runSizeCommand(g, 'o/r', { event: event('/size-exception generated client | big'), config: PLAN_ON });
  assert.match(r.lines[1], /Requested by dev: generated client \\\| big/);
  const body = g.calls.filter(([m]) => m === 'POST').at(-1)[2].body;
  assert.match(body, /\| Size \| ⏳ exception requested by `dev`: generated client \\\| big \|/);
  assert.match(body, /a listed approver \(`alice`\) who isn't the PR author decides/);
  assert.match((await runSizeCommand(gh(), 'o/r', { event: event('/size-exception'), config: PLAN_ON })).skip, /needs a reason/);
  assert.match((await runSizeCommand(gh(), 'o/r', { event: event('/size-exception x', 'NONE'), config: PLAN_ON })).skip, /members only/);
  assert.match((await runSizeCommand(gh(), 'o/r', { event: event('/size-exception x', 'MEMBER', { number: 7 }), config: PLAN_ON })).skip, /not a pull request/);
});

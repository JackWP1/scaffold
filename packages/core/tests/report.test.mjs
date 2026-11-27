import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise, renderReport, postReport, REPORT_MARKER } from '../actions/usage-report/report.mjs';
import { configFrom } from '../lib/config.mjs';
import { fakeGh } from './fake-github.mjs';

const bot = { login: 'github-actions[bot]', type: 'Bot' };
const alice = { login: 'alice', type: 'User' };
let id = 0;
const ev = (event, label, actor, issue, at) => ({ id: ++id, event, label: { name: label }, actor, issue: { number: issue }, created_at: at });

const events = [
  ev('labeled', 'scaffold:ready', bot, 1, '2026-11-20T09:00:00Z'),
  ev('labeled', 'scaffold:needs-info', bot, 2, '2026-11-20T09:00:00Z'),
  ev('labeled', 'scaffold:planned', bot, 1, '2026-11-20T10:00:00Z'),
  ev('labeled', 'scaffold:plan-approved', alice, 1, '2026-11-20T14:00:00Z'),
  ev('labeled', 'scaffold:planned', bot, 3, '2026-11-20T10:00:00Z'),
  ev('labeled', 'scaffold:plan-approved', alice, 3, '2026-11-20T11:00:00Z'),
  ev('unlabeled', 'scaffold:plan-approved', bot, 3, '2026-11-20T11:00:05Z'),
  ev('labeled', 'scaffold:too-big', bot, 4, '2026-11-21T10:00:00Z'),
  ev('labeled', 'scaffold:needs-gherkin', bot, 5, '2026-11-21T10:00:00Z'),
  ev('labeled', 'scaffold:gherkin-approved', alice, 5, '2026-11-21T12:00:00Z'),
  ev('unlabeled', 'scaffold:gherkin-approved', bot, 5, '2026-11-21T13:00:00Z'),
  ev('labeled', 'scaffold:needs-gherkin', bot, 5, '2026-11-21T13:00:00Z'),
  ev('labeled', 'scaffold:gherkin-approved', alice, 5, '2026-11-21T16:00:00Z'),
  ev('labeled', 'scaffold:needs-gherkin', bot, 6, '2026-11-21T10:00:00Z'),
  ev('labeled', 'scaffold:gherkin-approved', alice, 6, '2026-11-21T11:00:00Z'),
  ev('unlabeled', 'scaffold:gherkin-approved', alice, 6, '2026-11-21T12:00:00Z'),
];
const runs = [{ id: 1 }, { id: 2 }];
const jobs = {
  1: [{ name: 'triage / triage', conclusion: 'success' }, { name: 'plan / admit', conclusion: 'skipped' }],
  2: [{ name: 'plan / admit', conclusion: 'success' }, { name: 'plan / plan (1, 50)', conclusion: 'failure' }, { name: 'triage / gherkin', conclusion: 'success' }],
};

test('summarise counts jobs, skill outcomes and gate passes', () => {
  const n = summarise({ runs, jobs, events });
  assert.deepEqual(n.perJob, { 'triage / triage': { runs: 1, failed: 0 }, 'plan / admit': { runs: 1, failed: 0 }, 'plan / plan': { runs: 1, failed: 1 }, 'triage / gherkin': { runs: 1, failed: 0 } });
  assert.deepEqual(n.skills, { triage: 1, 'gherkin-writer': 1, 'task-decomposer': 1, 'code-review': 0, 'ci-diagnose': 0 });
  assert.deepEqual(n.scenarios, { needed: 3, applied: 3, passed: 1, failed: 2, medianHours: 3 });
  assert.deepEqual(n.triage, { ready: 1, needsInfo: 1, proposed: 0 });
  assert.deepEqual(n.plan, { admitted: 2, tooBig: 1 });
  assert.deepEqual(n.gate, { applied: 2, passed: 1, failed: 1, medianHours: 4 });
});

test('summarise counts conflicts: flagged, repeats, resolved and hours to resolve, false positives, queue', () => {
  const events = [
    ev('labeled', 'scaffold:conflict', bot, 7, '2026-11-20T10:00:00Z'),
    ev('labeled', 'scaffold:conflict-resolved', alice, 7, '2026-11-20T14:00:00Z'),
    ev('labeled', 'scaffold:conflict', bot, 7, '2026-11-21T10:00:00Z'),
    ev('labeled', 'scaffold:conflict', bot, 8, '2026-11-21T10:00:00Z'),
    ev('labeled', 'scaffold:conflict-resolved', { login: 'mallory', type: 'User' }, 8, '2026-11-21T11:00:00Z'),
  ];
  const comments = [{ user: bot, body: '<!-- scaffold:conflict -->\nx', reactions: { '-1': 1 } }, { user: bot, body: '<!-- scaffold:conflict -->\ny', reactions: {} }];
  const n = summarise({ runs: [], jobs: {}, events, comments, conflictQueue: 2, approvers: ['alice'] });
  assert.deepEqual(n.collaboration, { flagged: 3, resolved: 1, medianHoursToResolve: 4, repeatFlagged: 1, falsePositives: 1, queueNow: 2 });
  assert.match(renderReport({ from: 'a', to: 'b', numbers: n, config: configFrom('') }), /\| Collaboration: median hours from flag to resolution \| 4\.0 \|/);
  const same = '2026-11-22T10:00:00Z';
  const tie = summarise({ runs: [], jobs: {}, events: [ev('labeled', 'scaffold:conflict-resolved', alice, 9, same), ev('labeled', 'scaffold:conflict', bot, 9, same)], approvers: ['alice'] });
  assert.equal(tie.collaboration.resolved, 0, 'a resolution earlier in the timeline isn\'t paired with a later flag');
});

test('summarise counts code-review comments, diagnoses and 👎 false positives', () => {
  const c = (body, user = bot, down = 0) => ({ user, body, reactions: { '-1': down } });
  const n = summarise({
    runs: [], jobs: {}, events: [],
    reviews: [c('<!-- scaffold:code-review-run a -->'), c('<!-- scaffold:code-review-run b -->'), c('a human review', alice)],
    reviewComments: [c('<!-- scaffold:code-review -->\na'), c('<!-- scaffold:code-review -->\nb', bot, 2), c('<!-- scaffold:code-review -->\nforged', alice, 1)],
    comments: [c('<!-- scaffold:ci-diagnosis abc -->'), c('<!-- scaffold:ci-diagnosis def -->', bot, 1)],
  });
  assert.deepEqual(n.review, { codeReviewComments: 2, codeReviewFalsePositives: 1, diagnoses: 2, diagnosisFalsePositives: 1 });
  assert.equal(n.skills['code-review'], 2, 'one model call per posted review, not per job');
  assert.equal(n.skills['ci-diagnose'], 2);
  assert.match(renderReport({ from: 'a', to: 'b', numbers: n, config: configFrom('') }), /\| Review: CI diagnoses marked wrong \(👎\) \| 1 \|/);
});

test('summarise counts rework rounds, escalations, exceptions and open Copilot PRs per developer', () => {
  const implementEvents = [
    ev('labeled', 'scaffold:escalate', bot, 9, '2026-11-21T10:00:00Z'),
    ev('labeled', 'scaffold:size-exception', alice, 9, '2026-11-21T10:00:00Z'),
    ev('labeled', 'scaffold:test-change-approved', alice, 10, '2026-11-21T10:00:00Z'),
    ev('unlabeled', 'scaffold:test-change-approved', bot, 10, '2026-11-21T11:00:00Z'),
  ];
  const comments = [{ user: bot, body: '<!-- scaffold:rework a -->' }, { user: bot, body: '<!-- scaffold:rework b -->' }, { user: alice, body: '<!-- scaffold:rework c -->' }];
  const pr = (login, ...assignees) => ({ user: { login }, assignees: assignees.map((l) => ({ login: l })) });
  const n = summarise({ runs: [], jobs: {}, events: implementEvents, comments, openPrs: [pr('Copilot', 'dev', 'Copilot'), pr('Copilot', 'dev', 'ann'), pr('ann', 'dev')] });
  assert.deepEqual(n.implement, { reworkRounds: 2, escalated: 1, sizeExceptions: 1, testChangesApproved: 0, openPerDeveloper: [['ann', 1], ['dev', 2]] });
  const body = renderReport({ from: 'a', to: 'b', numbers: n, config: configFrom('') });
  assert.match(body, /\| Implement: automatic rework rounds \| 2 \|/);
  assert.match(body, /\| dev \| 2 \|/);
});

test('the report lists stages, flagging released packages that are off', () => {
  const body = renderReport({ from: 'a', to: 'b', numbers: summarise({ runs: [], jobs: {}, events: [] }), config: configFrom('stages:\n  intake: true') });
  assert.ok(body.startsWith(REPORT_MARKER));
  assert.ok(body.includes('| intake | on |') && body.includes('| plan | **off (manual)** |') && body.includes('| collaboration | **off (manual)** |'));
  assert.ok(body.includes('| Plan gate: median hours from admission to approval | - |'));
  assert.ok(renderReport({ from: 'a', to: 'b', numbers: summarise({ runs: [], jobs: {}, events: [] }), configError: 'x' }).includes('| plan | ⛔ config invalid |'));
});

test('the report is posted on the standing report issue, created once', async () => {
  const gh = fakeGh({
    '/repos/o/r/actions/runs/': { jobs: [] },
    '/repos/o/r/actions/runs': { workflow_runs: [{ id: 9, path: '.github/workflows/scaffold.yml', created_at: '2026-11-25T00:00:00Z' }, { id: 8, path: '.github/workflows/ci.yml', created_at: '2026-11-25T00:00:00Z' }] },
    '/repos/o/r/issues/events': [ev('labeled', 'scaffold:ready', bot, 1, '2026-11-25T00:00:00Z'), ev('labeled', 'scaffold:ready', bot, 1, '2026-11-01T00:00:00Z')],
    '/repos/o/r/issues?state=open&labels=scaffold%3Aconflict': [],
    '/repos/o/r/issues?state=open': [{ number: 5, body: 'other' }],
    '/repos/o/r/issues/12/comments': {},
    '/repos/o/r/issues/comments': [],
    '/repos/o/r/pulls/comments': [],
    '/repos/o/r/pulls?state=all': [],
    '/repos/o/r/pulls?state=open': [],
    '/repos/o/r/issues': { number: 12 },
  });
  const body = await postReport(gh, 'o/r', { now: new Date('2026-11-26T00:00:00Z'), config: configFrom('') });
  assert.match(body, /usage: 2026-11-19 to 2026-11-26/);
  assert.match(body, /\| Triage: ready \| 1 \|/);
  const posts = gh.calls.filter(([m]) => m === 'POST').map(([, p]) => p);
  assert.deepEqual(posts, ['/repos/o/r/issues', '/repos/o/r/issues/12/comments']);
  assert.deepEqual(gh.calls.filter(([, p]) => p.includes('/runs/')).map(([, p]) => p), ['/repos/o/r/actions/runs/9/jobs?per_page=100']);
});

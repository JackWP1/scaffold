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
];
const runs = [{ id: 1 }, { id: 2 }];
const jobs = {
  1: [{ name: 'triage / triage', conclusion: 'success' }, { name: 'plan / admit', conclusion: 'skipped' }],
  2: [{ name: 'plan / admit', conclusion: 'success' }, { name: 'plan / plan (1, 50)', conclusion: 'failure' }, { name: 'triage / gherkin', conclusion: 'success' }],
};

test('summarise counts jobs, skill outcomes and gate passes', () => {
  const n = summarise({ runs, jobs, events });
  assert.deepEqual(n.perJob, { 'triage / triage': { runs: 1, failed: 0 }, 'plan / admit': { runs: 1, failed: 0 }, 'plan / plan': { runs: 1, failed: 1 }, 'triage / gherkin': { runs: 1, failed: 0 } });
  assert.deepEqual(n.skills, { triage: 1, 'gherkin-writer': 1, 'task-decomposer': 1 });
  assert.deepEqual(n.scenarios, { needed: 2, applied: 2, passed: 1, failed: 1, medianHours: 3 });
  assert.deepEqual(n.triage, { ready: 1, needsInfo: 1, proposed: 0 });
  assert.deepEqual(n.plan, { admitted: 2, tooBig: 1 });
  assert.deepEqual(n.gate, { applied: 2, passed: 1, failed: 1, medianHours: 4 });
});

test('the report lists stages, flagging released packages that are off', () => {
  const body = renderReport({ from: 'a', to: 'b', numbers: summarise({ runs: [], jobs: {}, events: [] }), config: configFrom('stages:\n  intake: true') });
  assert.ok(body.startsWith(REPORT_MARKER));
  assert.ok(body.includes('| intake | on |') && body.includes('| plan | **off (manual)** |') && body.includes('| review | off (not released) |'));
  assert.ok(body.includes('| Plan gate: median hours from admission to approval | - |'));
  assert.ok(renderReport({ from: 'a', to: 'b', numbers: summarise({ runs: [], jobs: {}, events: [] }), configError: 'x' }).includes('| plan | ⛔ config invalid |'));
});

test('the report is posted on the standing report issue, created once', async () => {
  const gh = fakeGh({
    '/repos/o/r/actions/runs/': { jobs: [] },
    '/repos/o/r/actions/runs': { workflow_runs: [{ id: 9, path: '.github/workflows/scaffold.yml', created_at: '2026-11-25T00:00:00Z' }, { id: 8, path: '.github/workflows/ci.yml', created_at: '2026-11-25T00:00:00Z' }] },
    '/repos/o/r/issues/events': [ev('labeled', 'scaffold:ready', bot, 1, '2026-11-25T00:00:00Z'), ev('labeled', 'scaffold:ready', bot, 1, '2026-11-01T00:00:00Z')],
    '/repos/o/r/issues?state=open': [{ number: 5, body: 'other' }],
    '/repos/o/r/issues/12/comments': {},
    '/repos/o/r/issues': { number: 12 },
  });
  const body = await postReport(gh, 'o/r', { now: new Date('2026-11-26T00:00:00Z'), config: configFrom('') });
  assert.match(body, /usage: 2026-11-19 to 2026-11-26/);
  assert.match(body, /\| Triage: ready \| 1 \|/);
  const posts = gh.calls.filter(([m]) => m === 'POST').map(([, p]) => p);
  assert.deepEqual(posts, ['/repos/o/r/issues', '/repos/o/r/issues/12/comments']);
  assert.deepEqual(gh.calls.filter(([, p]) => p.includes('/runs/')).map(([, p]) => p), ['/repos/o/r/actions/runs/9/jobs?per_page=100']);
});

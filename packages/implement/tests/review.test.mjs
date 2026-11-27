import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configFrom } from '../../core/lib/config.mjs';
import { fakeGh } from '../../core/tests/fake-github.mjs';
import { reviewGate, waitForChecks, SCAFFOLD_CHECKS } from '../review.mjs';
import { workInProgress } from '../run.mjs';

const config = configFrom('stages:\n  implement: true\napprovers: [alice]\nmax_rework_rounds: 2');
const copilotPr = { number: 4, body: 'Fixes #7', user: { login: 'Copilot' }, base: { sha: 'base' }, head: { sha: 'abcdef1234' } };
const run = (name, conclusion = 'success', status = 'completed', extra = {}) => ({ name, status, conclusion: status === 'completed' ? conclusion : null, started_at: '2026-11-20T10:00:00Z', ...extra });
const scaffold = (conclusion = 'success') => SCAFFOLD_CHECKS.map((c) => run(`checks / ${c}`, conclusion));
const bot = { login: 'github-actions[bot]' };
const noWait = { pollMs: 1, waitMs: 0, sleep: async () => {} };

function gh({ runs = [...scaffold(), run('ci / test')], prLabels = [], comments = [], assignees = [{ login: 'dev' }, { login: 'Copilot' }] } = {}) {
  return fakeGh({
    '/repos/o/r/commits/abcdef1234/check-runs': typeof runs === 'function' ? () => ({ check_runs: runs() }) : { check_runs: runs },
    '/repos/o/r/issues/4/comments': (path) => (path.includes('page=') ? comments : {}),
    '/repos/o/r/issues/4/labels': null,
    '/repos/o/r/issues/4': { number: 4, labels: prLabels.map((name) => ({ name })) },
    '/repos/o/r/issues/7': { number: 7, assignees },
    '/repos/o/r/pulls/4/requested_reviewers': {},
  });
}
const posts = (g, suffix) => g.calls.filter(([m, p]) => m === 'POST' && p.endsWith(suffix)).map(([, , b]) => b);

test('waiting: until every SCAFFOLD check has reported and nothing is running; latest run per name', async () => {
  let n = 0;
  const g = gh({ runs: () => (n++ < 2 ? [run('ci / test', null, 'in_progress')] : [...scaffold(), run('ci / test', 'failure', 'completed', { started_at: '2026-11-20T09:00:00Z' }), run('ci / test', 'success', 'completed', { started_at: '2026-11-20T11:00:00Z' }), run('implement / scaffold-review-gate', null, 'in_progress')]) });
  const sleeps = [];
  const { runs } = await waitForChecks(g, 'o/r', 'abcdef1234', { pollMs: 5, waitMs: 100, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(sleeps.length, 2);
  assert.deepEqual(runs.filter((r) => r.name === 'ci / test').map((r) => r.conclusion), ['success']);
  assert.ok(!runs.some((r) => r.name.endsWith('scaffold-review-gate')));
  const { pending } = await waitForChecks(gh({ runs: [run('ci / test', null, 'queued')] }), 'o/r', 'abcdef1234', noWait);
  assert.deepEqual(pending.slice(0, 2), ['ci / test', 'scaffold-config-guard']);
});

test('review gate: every check passed: ready for human review, requested from the issue\'s developer', async () => {
  const g = gh();
  const r = await reviewGate({ gh: g, repo: 'o/r', pr: copilotPr, config, wait: noWait });
  assert.equal(r.ok, true);
  assert.match(r.outcome, /review requested from `dev`/);
  assert.deepEqual(posts(g, '/requested_reviewers'), [{ reviewers: ['dev'] }]);
  assert.deepEqual(r.rows, { 'Review gate': '✅ ready for human review', Rework: '0 of 2 rounds' });
});

test('review gate: a failing check on a Copilot PR asks for one rework round per commit', async () => {
  const runs = [...scaffold(), run('checks / scaffold-pr-size', 'failure', 'completed', { started_at: '2026-11-20T11:00:00Z', output: { title: 'over the soft limit @team' } }), run('ci / test', 'failure')];
  const g = gh({ runs });
  const r = await reviewGate({ gh: g, repo: 'o/r', pr: copilotPr, config, wait: noWait });
  assert.equal(r.ok, false);
  assert.match(r.outcome, /2 failing checks: rework round 1 of 2 asked/);
  const [comment] = posts(g, '/comments');
  assert.match(comment.body, /^<!-- scaffold:rework abcdef1234 -->\n@copilot Rework round 1 of 2: these checks failed on abcdef1/);
  assert.match(comment.body, /- \*\*checks \/ scaffold-pr-size\*\*: failure: over the soft limit @​team/);
  assert.match(comment.body, /Split it into a stack of PRs, each within the limit and no more than 5 in all/);
  assert.deepEqual(r.rows.Rework, '1 of 2 rounds');
  const again = gh({ runs, comments: [{ user: bot, body: comment.body }] });
  const r2 = await reviewGate({ gh: again, repo: 'o/r', pr: copilotPr, config, wait: noWait });
  assert.match(r2.outcome, /rework already asked for this commit/);
  assert.deepEqual(posts(again, '/comments'), []);
});

test('review gate: after max_rework_rounds the circuit breaker escalates to human review', async () => {
  const rounds = [{ user: bot, body: '<!-- scaffold:rework aaa -->\n@copilot' }, { user: bot, body: '<!-- scaffold:rework bbb -->\n@copilot' }];
  const g = gh({ runs: [...scaffold(), run('ci / test', 'failure')], comments: rounds });
  const r = await reviewGate({ gh: g, repo: 'o/r', pr: copilotPr, config, wait: noWait });
  assert.equal(r.ok, true);
  assert.match(r.outcome, /circuit breaker: 2 rework rounds used, `scaffold:escalate` applied; review requested from `dev`/);
  assert.deepEqual(posts(g, '/labels'), [{ labels: ['scaffold:escalate'] }]);
  assert.deepEqual(posts(g, '/comments'), [], 'no further rework round');
  const later = await reviewGate({ gh: gh({ runs: [...scaffold(), run('ci / test', 'failure')], prLabels: ['scaffold:escalate'] }), repo: 'o/r', pr: copilotPr, config, wait: noWait });
  assert.equal(later.ok, true);
  assert.match(later.outcome, /circuit breaker tripped/);
});

test('review gate: a human\'s PR gets no automatic rework; checks not finished in time fail without a round', async () => {
  const human = { ...copilotPr, user: { login: 'dev' } };
  const g = gh({ runs: [...scaffold(), run('ci / test', 'failure')] });
  const r = await reviewGate({ gh: g, repo: 'o/r', pr: human, config, wait: noWait });
  assert.equal(r.ok, false);
  assert.match(r.rows.Rework, /not a Copilot PR/);
  assert.deepEqual(posts(g, '/comments'), []);
  const slow = await reviewGate({ gh: gh({ runs: [run('ci / test', null, 'in_progress')] }), repo: 'o/r', pr: copilotPr, config, wait: noWait });
  assert.match(slow.outcome, /checks still running or not started: ci \/ test/);
});

test('work in progress: warns per assigned developer over warn_open_prs_per_developer (advisory)', async () => {
  const open = (login, ...assignees) => ({ user: { login }, assignees: assignees.map((a) => ({ login: a })) });
  const g = fakeGh({ '/repos/o/r/pulls?state=open': [open('Copilot', 'dev'), open('Copilot', 'dev', 'ann'), open('Copilot', 'dev'), open('ann', 'dev')] });
  const pr = { ...copilotPr, assignees: [{ login: 'dev' }, { login: 'ann' }, { login: 'Copilot' }] };
  assert.equal(await workInProgress(g, 'o/r', pr, configFrom('')), '⚠️ open Copilot PRs: `dev`: 3 (advisory: `warn_open_prs_per_developer` is 2)');
  assert.equal(await workInProgress(g, 'o/r', pr, configFrom('warn_open_prs_per_developer: 3')), '✅ open Copilot PRs: `dev`: 3, `ann`: 1');
});

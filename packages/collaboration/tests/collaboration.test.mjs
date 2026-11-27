import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configFrom } from '../../core/lib/config.mjs';
import { fakeGh } from '../../core/tests/fake-github.mjs';
import { pathsOverlap, specRefs, runCheck1, runCheck2, runResolve, CONFLICT_MARKER, CHECK2_MARKER } from '../conflict.mjs';
import { sortOrder, blockersIn, mergeOrderCheck } from '../merge.mjs';

const schema = JSON.parse(await readFile(new URL('../schemas/conflict-check.schema.json', import.meta.url), 'utf8'));
const config = configFrom('stages:\n  collaboration: true\napprovers: [alice]\nflow_lead: lead');
const bot = { login: 'github-actions[bot]', type: 'Bot' };
const person = (login) => ({ login, type: 'User' });
const planBody = (paths, approach = 'Do it') => `<!-- scaffold:plan -->\nplan\n<!-- scaffold:plan-data ${Buffer.from(JSON.stringify({ approach, affected_paths: paths, subtasks: [] })).toString('base64')} -->`;
const issue = (number, labels = ['scaffold:planned'], body = '') => ({ number, title: `T${number}`, body, user: { login: 'carol' }, labels: labels.map((name) => ({ name })) });
const labelCalls = (g) => g.calls.filter(([, p]) => p.includes('/labels')).map(([m, p, b]) => (m === 'DELETE' ? `${p.split('/')[5]}-${decodeURIComponent(p.split('/').pop())}` : `${p.split('/')[5]}+${b.labels.join(',')}`));
const posts = (g) => g.calls.filter(([m, p]) => m !== 'GET' && p.includes('/comments')).map(([, p, b]) => [p.split('/')[5], b.body]);

test('overlap is by path prefix, globs cut at the first wildcard; spec references are found in text', () => {
  assert.deepEqual(pathsOverlap(['src/auth/**', 'docs/x.md'], ['src/auth/login.js']), ['src/auth/']);
  assert.deepEqual(pathsOverlap(['src/auth'], ['src/author.js']), [], 'a prefix must end at a directory');
  assert.deepEqual(pathsOverlap(['src/a.js'], ['src/a.js']), ['src/a.js']);
  assert.deepEqual(specRefs('See docs/spec/login.md. And (docs/spec/api/users.md)'), ['docs/spec/login.md', 'docs/spec/api/users.md']);
});

function check1Gh({ others = [[8, ['src/auth/**']], [9, ['web/**']]], mine = ['src/auth/login.js'], comments = {} } = {}) {
  const routes = {
    '/repos/o/r/issues?state=open&labels=scaffold%3Aplanned': others.map(([n]) => issue(n)),
    '/repos/o/r/issues?state=open&labels=scaffold%3Aplan-approved': [issue(7, ['scaffold:plan-approved'])],
    '/repos/o/r/issues/comments/': {},
    '/repos/o/r/contents/': new Error('GET: 404 Not Found'),
  };
  for (const [n, paths] of others) {
    routes[`/repos/o/r/issues/${n}/comments`] = [{ user: bot, body: planBody(paths) }];
    routes[`/repos/o/r/issues/${n}`] = issue(n);
  }
  routes['/repos/o/r/issues/7/comments'] = (p) => (p.includes('page=') ? [{ user: bot, body: planBody(mine) }, ...(comments[7] ?? [])] : { html_url: 'c' });
  routes['/repos/o/r/issues/7/labels'] = null;
  routes['/repos/o/r/issues/7'] = issue(7, ['scaffold:plan-approved']);
  return fakeGh(routes);
}
const event1 = { action: 'labeled', label: { name: 'scaffold:plan-approved' }, issue: { number: 7 } };
async function check1({ gh = check1Gh(), reply = { summary: 'Both change login', findings: [{ with: [8, 99], kind: 'conflict', spec: ['docs/spec/login.md'], explanation: 'Both rewrite the session @team' }] } } = {}) {
  const prompts = [];
  const r = await runCheck1(gh, 'o/r', { event: event1, config, loadSkill: async () => ({ system: 'S', schema, version: '0.1.0', model: 'deep' }), callModel: async ({ user }) => { prompts.push(user); return structuredClone(reply); } });
  return { ...r, prompts, gh };
}

test('check 1: only overlapping in-flight tickets are shortlisted; a real conflict flags the ticket', async () => {
  const { prompts, gh, lines } = await check1();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /### #8 \(shortlisted: affected paths src\/auth\/login\.js\)/);
  assert.doesNotMatch(prompts[0], /### #9/);
  assert.deepEqual(labelCalls(gh), ['7+scaffold:conflict']);
  const [, conflict] = posts(gh).find(([n, b]) => n === '7' && b.startsWith(CONFLICT_MARKER));
  assert.match(conflict, /Involves #8\./, 'numbers outside the shortlist (#99) are dropped');
  assert.match(conflict, /- \*\*conflict\*\* with #8 \(`docs\/spec\/login\.md`\): Both rewrite the session @​team/);
  assert.match(posts(gh).at(-1)[1], /\| Conflicts \| 🚧 conflict with #8 \(check 1\) \|/);
  assert.match(lines[1], /1 finding: flagged/);
});

test('check 1: nothing overlapping means no model call; no findings means no flag', async () => {
  const none = await check1({ gh: check1Gh({ others: [[9, ['web/**']]] }) });
  assert.deepEqual(none.prompts, []);
  assert.match(posts(none.gh).at(-1)[1], /\| Conflicts \| ✅ no overlapping work \(check 1\) \|/);
  const clean = await check1({ reply: { summary: 'fine', findings: [] } });
  assert.deepEqual(labelCalls(clean.gh), []);
  assert.match(posts(clean.gh).at(-1)[1], /✅ no conflicts \(check 1, 1 overlap judged\)/);
});

test('resolve: a listed approver after the flag clears it; anyone else is refused', async () => {
  const flagEv = { id: 1, event: 'labeled', label: { name: 'scaffold:conflict' }, actor: bot, created_at: '2026-11-20T10:00:00Z' };
  const res = (login) => ({ id: 2, event: 'labeled', label: { name: 'scaffold:conflict-resolved' }, actor: person(login), created_at: '2026-11-20T11:00:00Z' });
  const g = (events) => fakeGh({ '/repos/o/r/issues/7/comments': (p) => (p.includes('page=') ? [] : {}), '/repos/o/r/issues/7/events': events, '/repos/o/r/issues/7/labels': null, '/repos/o/r/issues/7': issue(7, ['scaffold:conflict', 'scaffold:conflict-resolved']) });
  const ev = { action: 'labeled', label: { name: 'scaffold:conflict-resolved' }, issue: { number: 7 } };
  const ok = g([flagEv, res('alice')]);
  await runResolve(ok, 'o/r', { event: ev, config });
  assert.deepEqual(labelCalls(ok), ['7-scaffold:conflict']);
  assert.match(posts(ok).at(-1)[1], /✅ resolved by `alice`/);
  const bad = g([flagEv, res('mallory')]);
  await runResolve(bad, 'o/r', { event: ev, config });
  assert.deepEqual(labelCalls(bad), ['7-scaffold:conflict-resolved']);
  assert.match(posts(bad).at(-1)[1], /still open: `mallory` is not a listed approver/);
});

const graphqlFor = (decisions, queue = []) => async (q, v) => (q.includes('mergeQueue')
  ? { repository: { mergeQueue: { entries: { nodes: queue.map((n, i) => ({ position: i + 1, pullRequest: { number: n } })) } } } }
  : { repository: { pullRequest: { reviewDecision: decisions[v.number] ?? 'REVIEW_REQUIRED' } } });

test('check 2: waits for the review decision; a clean result is recorded for the head commit', async () => {
  const pr = { number: 4, body: 'Fixes #7', title: 'Login', head: { sha: 'abc', ref: 'feat' }, base: { sha: 'b0', ref: 'main' } };
  const g = fakeGh({
    '/repos/o/r/pulls?state=open': [pr, { number: 5, body: 'Fixes #8', title: 'Other', head: { ref: 'x' } }],
    '/repos/o/r/pulls/4/files': [{ filename: 'src/a.js' }],
    '/repos/o/r/pulls/5/files': [{ filename: 'src/b.js' }],
    '/repos/o/r/compare/': { files: [] },
    '/repos/o/r/issues/4/comments': (p) => (p.includes('page=') ? [] : {}),
    '/repos/o/r/issues/7/comments': (p) => (p.includes('page=') ? [] : {}),
    '/repos/o/r/issues/7': issue(7, ['scaffold:plan-approved']),
  });
  g.graphql = graphqlFor({ 4: 'APPROVED', 5: 'APPROVED' });
  const ev = { action: 'submitted', review: { state: 'approved' }, pull_request: pr };
  const r = await runCheck2(g, 'o/r', { event: ev, config, loadSkill: async () => { throw new Error('no model call expected'); }, callModel: null });
  assert.match(r.lines[1], /nothing overlaps: no model call/);
  assert.ok(posts(g).some(([n, b]) => n === '4' && b.startsWith(`${CHECK2_MARKER} abc clean -->`)));
  g.graphql = graphqlFor({});
  assert.match((await runCheck2(g, 'o/r', { event: ev, config })).skip, /haven't approved it yet/);
});

test('merge order: blockers, then priority, then earliest approval; a stack stays bottom-up', () => {
  const item = (number, { blocks = 0, priority = 3, approvedAt = '2026-11-20T10:00:00Z', head = `h${number}`, base = 'main' } = {}) => ({ number, blocks, priority, approvedAt, pr: { head: { ref: head }, base: { ref: base } } });
  const order = sortOrder([
    item(1, { priority: 2, approvedAt: '2026-11-20T09:00:00Z' }),
    item(2, { priority: 0 }),
    item(3, { blocks: 1, priority: 2 }),
    item(4, { priority: 0, approvedAt: '2026-11-20T08:00:00Z', head: 'top', base: 'h5' }),
    item(5, { priority: 2, approvedAt: '2026-11-20T11:00:00Z', head: 'h5' }),
  ]);
  assert.deepEqual(order.map((o) => o.number), [3, 5, 4, 2, 1]);
  assert.deepEqual(blockersIn('Blocked by #12 and depends on #3; see #4'), [12, 3]);
});

function orderGh({ prs, queue = [], overrides = {} }) {
  const routes = { '/repos/o/r/pulls?state=open': prs.map((p) => p.pr), '/repos/o/r/issues?state=open': [] };
  for (const { pr, issue: n, approvedAt } of prs) {
    routes[`/repos/o/r/issues/${pr.number}/comments`] = (p) => (p.includes('page=') ? [{ user: bot, body: `${CHECK2_MARKER} ${pr.head.sha} clean -->`, updated_at: '2026-11-20T10:00:00Z' }, ...(overrides[pr.number]?.comments ?? [])] : {});
    routes[`/repos/o/r/issues/${pr.number}/events`] = overrides[pr.number]?.events ?? [];
    routes[`/repos/o/r/pulls/${pr.number}/reviews`] = [{ state: 'APPROVED', commit_id: pr.head.sha, submitted_at: approvedAt }];
    routes[`/repos/o/r/issues/${n}/events`] = [];
    routes[`/repos/o/r/issues/${n}`] = issue(n, ['scaffold:plan-approved']);
  }
  const g = fakeGh(routes);
  g.graphql = graphqlFor(Object.fromEntries(prs.map((p) => [p.pr.number, 'APPROVED'])), queue);
  return g;
}
const prItem = (number, n, approvedAt) => ({ issue: n, approvedAt, pr: { number, body: `Fixes #${n}`, draft: false, head: { sha: `s${number}`, ref: `h${number}` }, base: { ref: 'main' } } });
const mgEvent = (n) => ({ merge_group: { head_ref: `refs/heads/gh-readonly-queue/main/pr-${n}-abc123`, base_ref: 'refs/heads/main' } });

test('merge-order check: passes in order, fails when jumping, passes with the flow lead\'s override', async () => {
  const prs = [prItem(4, 7, '2026-11-20T09:00:00Z'), prItem(5, 8, '2026-11-20T11:00:00Z')];
  assert.equal((await mergeOrderCheck(orderGh({ prs }), 'o/r', { event: mgEvent(4), config })).ok, true);
  const jump = await mergeOrderCheck(orderGh({ prs }), 'o/r', { event: mgEvent(5), config });
  assert.equal(jump.ok, false);
  assert.match(jump.outcome, /PR #5 is 2 of 2: #4 must merge or enter the queue first/);
  assert.equal((await mergeOrderCheck(orderGh({ prs, queue: [4, 5] }), 'o/r', { event: mgEvent(5), config })).ok, true, '#4 is ahead in the queue');
  const later = '2026-11-20T12:00:00Z';
  const override = { 5: { events: [{ event: 'labeled', label: { name: 'scaffold:order-override' }, actor: person('lead'), created_at: later }], comments: [{ body: '/order-override hotfix for the outage', user: { login: 'lead' }, created_at: later }] } };
  const ok = await mergeOrderCheck(orderGh({ prs, overrides: override }), 'o/r', { event: mgEvent(5), config });
  assert.equal(ok.ok, true);
  assert.match(ok.outcome, /overridden by `lead`: hotfix for the outage/);
  const byOther = { 5: { ...override[5], events: [{ ...override[5].events[0], actor: person('dev') }] } };
  assert.equal((await mergeOrderCheck(orderGh({ prs, overrides: byOther }), 'o/r', { event: mgEvent(5), config })).ok, false);
  const stale = { 5: { events: [{ ...override[5].events[0], created_at: '2026-11-20T09:00:00Z' }], comments: override[5].comments } };
  assert.equal((await mergeOrderCheck(orderGh({ prs, overrides: stale }), 'o/r', { event: mgEvent(5), config })).ok, false, 'an override from before the position is stale');
});

test('merge-order check: a PR without a position (e.g. check 2 not passed) fails', async () => {
  const g = orderGh({ prs: [prItem(4, 7, '2026-11-20T09:00:00Z')] });
  g.graphql = graphqlFor({});
  const r = await mergeOrderCheck(g, 'o/r', { event: mgEvent(4), config });
  assert.match(r.outcome, /PR #4 has no merge position: not approved/);
});

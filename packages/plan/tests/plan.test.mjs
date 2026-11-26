import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validate } from '../../core/lib/validate.mjs';
import { configFrom, DEFAULTS } from '../../core/lib/config.mjs';
import { MARKER, setGates } from '../../core/lib/status.mjs';
import { loadSkill } from '../../core/lib/skills.mjs';
import { fakeGh } from '../../core/tests/fake-github.mjs';
import { PLAN_MARKER, checkPlan, evaluateApproval, encodePlan, decodePlan, planHash, isTooBig, isSubTicketPlan } from '../rules.mjs';
import { renderPlan } from '../render.mjs';
import { runGate } from '../gate.mjs';
import { runPlan } from '../planner.mjs';
import { admit, recentPlanComments, issueNumber } from '../admission.mjs';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const schema = JSON.parse(await readFile(new URL('../schemas/plan.schema.json', import.meta.url), 'utf8'));
const limits = DEFAULTS.pr_size;
const MAX = DEFAULTS.max_stack_prs;
// The plan package on its own: intake is off, so issues arrive in the state a manual intake leaves.
const PLAN_ONLY = 'stages:\n  plan: true\napprovers: [alice]';
const BOTH = 'stages:\n  intake: true\n  plan: true\napprovers: [alice]';

const task = (id, files, lines, blocked_by = []) => ({
  id, title: `Task ${id}`, description: 'Do it', blocked_by, acceptance_criteria: ['Works'], affected_paths: ['src/a.js'], estimate: { files, lines },
});
const plan = (split, subtasks, estimate = { files: 4, lines: 200 }) => ({
  approach: 'Change the thing', split, estimate, acceptance_criteria: ['It works'], affected_paths: ['src/**'], subtasks, risks: [],
});
const small = plan('none', [task('1', 2, 100), task('2', 2, 100, ['1'])]);
const stackOf = (n) => plan('stack', Array.from({ length: n }, (_, i) => task(String(i + 1), 5, 500, i ? [String(i)] : [])), { files: 5 * n, lines: 500 * n });

test('task-decomposer skill loads from the plan package with the standard tier', async () => {
  const skill = await loadSkill(PACKAGE, 'task-decomposer');
  const models = await readFile(new URL('../../core/config/models.yml', import.meta.url), 'utf8');
  assert.equal(skill.model, models.match(/^standard:\s*(\S+)/m)[1]);
  assert.equal(skill.version, '0.2.0');
  assert.deepEqual(skill.schema, schema);
  assert.ok(skill.system.includes('# Task decomposer'));
  assert.ok(!skill.system.includes('sub-tickets'));
});

test('valid plan output passes the schema; bad estimates and sub-tickets do not', () => {
  assert.deepEqual(validate(schema, small), []);
  const bad = plan('none', [task('1', -1, 1.5)]);
  const errors = validate(schema, bad);
  assert.ok(errors.some((e) => e.includes('files: less than 0')));
  assert.ok(errors.some((e) => e.includes('lines: expected integer')));
  assert.match(validate(schema, plan('sub-tickets', [task('1', 1, 1)])).join(), /split: not one of none, stack, too-big/);
});

test('size rules: unsplit work must fit the soft limit', () => {
  assert.deepEqual(checkPlan(small, limits, MAX), []);
  const big = plan('none', [task('1', 20, 3000)], { files: 20, lines: 3000 });
  assert.match(checkPlan(big, limits, MAX)[0], /over the soft limit .* not split/);
});

test('size rules: each stack layer must fit, the stack must fit max_stack_prs, too-big is refused', () => {
  const est = { files: 20, lines: 3000 };
  assert.deepEqual(checkPlan(plan('stack', [task('1', 10, 900), task('2', 10, 900, ['1'])], est), limits, MAX), []);
  assert.match(checkPlan(plan('stack', [task('1', 11, 900), task('2', 9, 900)], est), limits, MAX)[0], /sub-task 1 .* over the soft limit/);
  assert.ok(checkPlan(plan('stack', [task('1', 2, 100)], est), limits, MAX).some((p) => p.includes('at least 2 PRs')));
  assert.deepEqual(checkPlan(stackOf(3), limits, 3), []);
  assert.match(checkPlan(stackOf(4), limits, 3)[0], /a stack of 4 PRs is more than 3 \(`max_stack_prs`\): back to triage/);
  assert.match(checkPlan(plan('too-big', [], est), limits, 3)[0], /needs more than 3 PRs \(`max_stack_prs`\): back to triage/);
});

test('too big means split too-big, or a stack over max_stack_prs', () => {
  assert.equal(isTooBig(plan('too-big', []), 5), true);
  assert.equal(isTooBig(stackOf(6), 5), true);
  assert.equal(isTooBig(stackOf(5), 5), false);
  assert.equal(isTooBig(small, 1), false);
});

test('size rules: blocking edges must point to earlier sub-tasks', () => {
  const p = plan('none', [task('1', 1, 10, ['2']), task('2', 1, 10)]);
  assert.match(checkPlan(p, limits, MAX)[0], /blocked by 2, which is not an earlier sub-task/);
});

test('a plan with no sub-tasks is not approvable', () => {
  assert.deepEqual(checkPlan(plan('none', []), limits, MAX), ['the plan has no sub-tasks']);
});

const planBody = (p, over = {}) => renderPlan(p, { problems: [], skillVersion: '0.2.0', model: 'm', limits, maxStack: MAX, ...over });

test('plan data round-trips through the comment and rejects tampering', () => {
  const body = planBody(small);
  assert.deepEqual(decodePlan(body, schema), small);
  assert.equal(decodePlan(body.replace(/plan-data \S+/, `plan-data ${Buffer.from('{"x":1}').toString('base64')}`), schema), null);
  assert.equal(decodePlan('no data', schema), null);
  assert.ok(encodePlan(small).startsWith('<!-- scaffold:plan-data '));
});

test('a pre-Phase 1b sub-ticket plan is recognised but no longer decodes', () => {
  const old = `${PLAN_MARKER}\n${encodePlan(plan('sub-tickets', [task('1', 2, 10), task('2', 2, 10)]))}`;
  assert.equal(decodePlan(old, schema), null);
  assert.equal(isSubTicketPlan(old), true);
  assert.equal(isSubTicketPlan(planBody(small)), false);
});

test('plan comment escapes model text and shows problems; no sub-ticket wording', () => {
  const evil = plan('none', [{ ...task('1', 1, 1), title: 'ping @admin', description: '<img src=x>' }]);
  evil.affected_paths = ['src/`x`\n@y'];
  const body = planBody(evil, { problems: ['estimate is over'] });
  assert.ok(body.startsWith(PLAN_MARKER));
  assert.ok(!body.includes('@admin') && !body.includes('<img'));
  assert.ok(body.includes('- `src/ x @y`'));
  assert.ok(body.includes('> - estimate is over'));
  assert.ok(!/sub-ticket/i.test(planBody(stackOf(2))));
  assert.ok(planBody(stackOf(2)).includes('#### PRs in the stack'));
});

test('a too-big plan comment says it went back to triage, not that it awaits approval', () => {
  const body = planBody(stackOf(6), { tooBig: true });
  assert.ok(body.includes('**Delivered as:** too big: needs more than 5 PRs'));
  assert.ok(body.includes('gone back to triage'));
  assert.ok(!body.includes('applies `scaffold:plan-approved`'));
});

const approved = (login, at = '2026-11-18T12:00:00Z', type = 'User') => ({ id: 7, event: 'labeled', label: { name: 'scaffold:plan-approved' }, actor: { login, type }, created_at: at });
const planComment = { body: 'plan', updated_at: '2026-11-18T11:00:00Z' };
const gate = (over) => evaluateApproval({ events: [approved('Alice')], author: 'carol', approvers: ['alice'], planComment, plan: small, limits, maxStack: MAX, ...over });

test('plan gate passes for a listed approver after the plan was posted', () => {
  assert.deepEqual(gate({}), { ok: true, approver: 'Alice', at: '2026-11-18T12:00:00Z', eventId: 7, hash: planHash('plan') });
});

test('plan gate uses core\'s timeline check: author, bot, unlisted, no label, edited', () => {
  assert.match(gate({ author: 'alice' }).reason, /author can't approve/);
  assert.match(gate({ events: [approved('alice', undefined, 'Bot')] }).reason, /bot/);
  assert.match(gate({ approvers: [] }).reason, /not a listed approver/);
  assert.match(gate({ events: [] }).reason, /was not applied/);
  assert.match(gate({ planComment: { ...planComment, updated_at: '2026-11-18T12:00:01Z' } }).reason, /changed after it was approved/);
  assert.match(gate({ planComment: undefined }).reason, /no plan: comment `\/plan` first/);
});

test('plan gate fails a missing, too-big or oversized-stack plan, and names removed sub-tickets', () => {
  assert.match(gate({ plan: null }).reason, /missing or invalid/);
  assert.equal(gate({ plan: null, subTickets: true }).reason, 'sub-tickets removed: run `/plan` again');
  assert.match(gate({ plan: plan('too-big', []) }).reason, /size rules/);
  assert.match(gate({ plan: stackOf(4), maxStack: 3 }).reason, /more than 3/);
  assert.match(gate({ plan: plan('none', []) }).reason, /no sub-tasks/);
});

const bot = { login: 'github-actions[bot]' };

// Gate runs against a fake issue. `labels` are the issue's current labels; the event payload's can differ.
// `plans` are the bot's plan comment bodies; `later` are events that appear only on a second read;
// `history` is scaffold-config.yml at each commit, newest first, for the stage switch history.
async function gateRun({ action = 'labeled', labels = ['scaffold:plan-approved'], payloadLabels = labels, plans = [], planUpdated = '2026-11-18T11:00:00Z', events = [approved('alice')], later = [], comment, changes, config = configFrom(PLAN_ONLY), configError, history = [PLAN_ONLY] } = {}) {
  const comments = plans.map((body, i) => ({ id: 5 + i, user: bot, body, updated_at: planUpdated, html_url: 'u' }));
  let reads = 0;
  const gh = fakeGh({
    '/repos/o/r/issues/1/comments': comments,
    '/repos/o/r/issues/1/events': () => (reads++ ? [...events, ...later] : events),
    '/repos/o/r/issues/1/labels': null,
    '/repos/o/r/issues/1': { number: 1, user: { login: 'carol' }, labels: labels.map((name) => ({ name })) },
    '/repos/o/r/commits': history.map((_, i) => ({ sha: `s${i}`, commit: { committer: { date: `2026-11-${String(20 - i).padStart(2, '0')}T00:00:00Z` } } })),
    '/repos/o/r/contents/.github/scaffold-config.yml': (path) => ({ content: Buffer.from(history[Number(path.match(/ref=s(\d+)/)[1])]).toString('base64') }),
  });
  const event = {
    action,
    label: action === 'labeled' ? { name: 'scaffold:plan-approved' } : undefined,
    comment,
    changes,
    issue: { number: 1, user: { login: 'carol' }, labels: payloadLabels.map((name) => ({ name })) },
  };
  const out = await runGate(gh, 'o/r', { event, schema, config: configError ? undefined : config, configError });
  const labelCalls = gh.calls.filter(([, path]) => path.includes('/labels')).map(([m, path, body]) => (m === 'DELETE' ? `-${decodeURIComponent(path.split('/').pop())}` : body.labels.map((l) => `+${l}`).join(' ')));
  const status = gh.calls.filter(([, path]) => path.endsWith('/comments') || path.includes('/issues/comments/')).filter(([m]) => m !== 'GET').at(-1)?.[2]?.body;
  return { out, labelCalls, status, text: out.lines?.join('\n') };
}

test('gate passes a valid approval and drops scaffold:planned', async () => {
  const { out, labelCalls, status } = await gateRun({ labels: ['scaffold:planned', 'scaffold:plan-approved'], plans: [planBody(small)] });
  assert.ok(out.lines.some((l) => l.includes('| pass |')));
  assert.deepEqual(labelCalls, ['-scaffold:planned']);
  assert.match(status, /\| Triage \| ✋ manual \(`intake` stage off/);
  assert.match(status, /\| Approval \| ✅ approved by `alice`/);
});

test('gate passes a stack within max_stack_prs', async () => {
  const { out } = await gateRun({ labels: ['scaffold:planned', 'scaffold:plan-approved'], plans: [planBody(stackOf(3))], config: configFrom(`${PLAN_ONLY}\nmax_stack_prs: 3`) });
  assert.ok(out.lines.some((l) => l.includes('| pass |')));
});

test('deleting the plan comment withdraws approval and goes back to Ready', async () => {
  const deleted = { body: `${PLAN_MARKER}\nold`, user: bot };
  for (const labels of [['scaffold:plan-approved'], ['scaffold:planned']]) {
    const { out, labelCalls, status } = await gateRun({ action: 'deleted', comment: deleted, labels, events: [{ event: 'labeled', label: { name: 'scaffold:planned' }, created_at: '2026-11-20T01:00:00Z' }] });
    assert.match(out.lines.join('\n'), /deleted or its marker removed: approval withdrawn/);
    assert.ok(labelCalls.includes('+scaffold:ready'));
    assert.ok(labelCalls.includes(`-${labels[0]}`));
    assert.match(status, /\| Plan \| 🗑️ plan deleted or its marker removed \|/);
  }
  assert.equal((await gateRun({ action: 'deleted', comment: { body: 'hi' } })).out.skip, 'comment is not the plan');
});

test('an edit that removes or moves the plan marker withdraws approval', async () => {
  const comment = { body: `tampered\n${PLAN_MARKER}`, user: bot };
  const { text, labelCalls } = await gateRun({ action: 'edited', comment, changes: { body: { from: `${PLAN_MARKER}\nold` } } });
  assert.match(text, /marker removed: approval withdrawn/);
  assert.deepEqual(labelCalls, ['-scaffold:plan-approved', '+scaffold:ready']);
});

test('an edit that keeps the marker fails the approval; edits to other comments are skipped', async () => {
  const body = planBody(small);
  const { text, labelCalls } = await gateRun({ action: 'edited', comment: { body, user: bot }, plans: [body], planUpdated: '2026-11-18T13:00:00Z' });
  assert.match(text, /fail: the plan changed after it was approved/);
  assert.deepEqual(labelCalls, ['-scaffold:plan-approved', '+scaffold:planned']);
  const status = await gateRun({ action: 'edited', comment: { body: `${MARKER}\nx`, user: bot }, changes: { body: { from: `${MARKER}\ny` } }, plans: [body] });
  assert.equal(status.out.skip, 'comment is not the plan');
});

test('cutover: approving a pre-Phase 1b sub-ticket plan fails and keeps the in-flight slot', async () => {
  const old = `${PLAN_MARKER}\nold plan\n${encodePlan(plan('sub-tickets', [task('1', 2, 10), task('2', 2, 10)]))}`;
  const { text, labelCalls, status } = await gateRun({ labels: ['scaffold:planned', 'scaffold:plan-approved'], plans: [old] });
  assert.match(text, /fail: sub-tickets removed: run `\/plan` again/);
  assert.deepEqual(labelCalls, ['-scaffold:plan-approved', '+scaffold:planned']);
  assert.match(status, /\| Approval \| ❌ not approved: sub-tickets removed: run `\/plan` again \|/);
});

test('a failed approval on an issue that is not in flight does not reserve a slot', async () => {
  const { labelCalls } = await gateRun({ labels: ['scaffold:too-big', 'scaffold:plan-approved'], plans: [planBody(plan('too-big', []), { tooBig: true })] });
  assert.deepEqual(labelCalls, ['-scaffold:plan-approved']);
});

test('two comments marked as the plan fail the gate', async () => {
  const { text } = await gateRun({ plans: [planBody(small), `${PLAN_MARKER}\nforged`] });
  assert.match(text, /fail: more than one comment is marked as the plan/);
});

test('an invalid scaffold-config.yml fails the gate', async () => {
  const { text, status } = await gateRun({ plans: [planBody(small)], configError: '$.max_in_flight: expected integer' });
  assert.match(text, /fail: `.github\/scaffold-config.yml` is invalid: \$.max_in_flight: expected integer/);
  assert.match(status, /\| Approval \| ❌ not approved: `.github\/scaffold-config.yml` is invalid/);
});

test('the gate reads current labels, not the event payload', async () => {
  const { out, labelCalls } = await gateRun({ labels: ['scaffold:planned'], payloadLabels: ['scaffold:plan-approved'], plans: [planBody(small)] });
  assert.equal(out.skip, 'scaffold:plan-approved is not applied');
  assert.deepEqual(labelCalls, []);
});

test('a /plan admitted while the gate runs supersedes the approval', async () => {
  const withdrawn = { id: 8, event: 'unlabeled', label: { name: 'scaffold:plan-approved' }, actor: bot };
  const { text, labelCalls, status } = await gateRun({ labels: ['scaffold:planned', 'scaffold:plan-approved'], plans: [planBody(small)], later: [withdrawn] });
  assert.match(text, /\| superseded by \/plan \|/);
  assert.deepEqual(labelCalls, ['-scaffold:planned', '+scaffold:planned']);
  assert.equal(status, undefined);
});

test('an approval with no plan comment also goes back to Ready', async () => {
  const { labelCalls } = await gateRun();
  assert.deepEqual(labelCalls, ['-scaffold:plan-approved', '+scaffold:ready']);
});

test('an issue planned by hand before the plan stage was on is left to the humans', async () => {
  const manualPlan = { event: 'labeled', label: { name: 'scaffold:planned' }, actor: { login: 'dave', type: 'User' }, created_at: '2026-11-10T00:00:00Z' };
  // Config history, newest first: plan turned on at the 2026-11-19 commit, after the issue was planned.
  const history = [PLAN_ONLY, PLAN_ONLY, 'stages:\n  plan: false'];
  const { text, labelCalls, status } = await gateRun({ labels: ['scaffold:planned', 'scaffold:plan-approved'], events: [manualPlan, approved('alice')], history });
  assert.match(text, /Planned before the `plan` stage was on/);
  assert.deepEqual(labelCalls, []);
  assert.match(status, /\| Plan \| ✋ manual \(before `plan` was on\) \|/);
  // Planned after it was turned on: the gate applies as usual.
  const after = await gateRun({ labels: ['scaffold:planned', 'scaffold:plan-approved'], events: [{ ...manualPlan, created_at: '2026-11-19T12:00:00Z' }, approved('alice')], history });
  assert.deepEqual(after.labelCalls, ['-scaffold:planned', '-scaffold:plan-approved', '+scaffold:ready']);
});

const issue = (labels, number = 1) => ({ number, labels: labels.map((name) => ({ name })) });
const planCmd = (over) => ({ id: 50, body: '/plan', author_association: 'MEMBER', user: { type: 'User' }, ...over });
function admitGh({ reactions = [], inFlightIssues = [] } = {}) {
  return fakeGh({
    '/repos/o/r/issues/comments/50/reactions': (path) => (path.includes('page=') ? reactions : {}),
    '/repos/o/r/issues?state=open': inFlightIssues,
    '/repos/o/r/issues/1/comments': [],
    '/repos/o/r/issues/1/labels': null,
  });
}
const posted = (gh, suffix) => gh.calls.filter(([m, path]) => m === 'POST' && path.endsWith(suffix)).map(([, , body]) => body);

test('admission reserves a slot: 👀, scaffold:planned, approval withdrawn', async () => {
  const gh = admitGh();
  const r = await admit(gh, 'o/r', { issue: issue(['scaffold:ready', 'scaffold:plan-approved']), comment: planCmd(), config: configFrom(PLAN_ONLY) });
  assert.equal(r.outcome, 'admitted');
  assert.deepEqual(posted(gh, '/reactions'), [{ content: 'eyes' }]);
  assert.deepEqual(posted(gh, '/labels'), [{ labels: ['scaffold:planned'] }]);
  assert.ok(gh.calls.some(([m, path]) => m === 'DELETE' && path.endsWith('scaffold%3Aplan-approved')));
});

test('admission refuses at the in-flight limit, counting other issues once', async () => {
  const gh = admitGh({ inFlightIssues: [{ number: 2 }, { number: 3, pull_request: {} }, { number: 1 }] });
  const r = await admit(gh, 'o/r', { issue: issue(['scaffold:ready']), comment: planCmd(), config: configFrom(`${PLAN_ONLY}\nmax_in_flight: 1`) });
  assert.equal(r.outcome, 'refused');
  assert.equal(r.reason, '1 of 1 tickets in flight');
  assert.deepEqual(posted(gh, '/reactions'), [{ content: 'confused' }]);
  assert.match(posted(gh, '/comments')[0].body, /\| Plan \| ⏸️ waiting: 1 of 1 tickets in flight \|/);
  assert.match(posted(gh, '/comments')[0].body, /\| Triage \| ✋ manual/);
});

test('admission refuses when scaffold-config.yml is invalid', async () => {
  const gh = admitGh();
  const r = await admit(gh, 'o/r', { issue: issue(['scaffold:ready']), comment: planCmd(), configError: '$.max_in_flight: expected integer' });
  assert.equal(r.outcome, 'refused');
  assert.deepEqual(posted(gh, '/reactions'), [{ content: 'confused' }]);
  assert.match(posted(gh, '/comments')[0].body, /\| Plan \| ⛔ `.github\/scaffold-config.yml` is invalid: \$.max_in_flight: expected integer \|/);
  assert.deepEqual(posted(gh, '/labels'), []);
});

test('admission skips handled comments and refuses non-members, unready and too-big issues', async () => {
  const config = configFrom(PLAN_ONLY);
  const done = admitGh({ reactions: [{ user: bot, content: 'eyes' }] });
  assert.equal((await admit(done, 'o/r', { issue: issue(['scaffold:ready']), comment: planCmd(), config })).reason, 'already handled');
  assert.deepEqual(posted(done, '/reactions'), []);
  const other = admitGh({ reactions: [{ user: { login: 'bob' }, content: 'eyes' }] });
  assert.equal((await admit(other, 'o/r', { issue: issue(['scaffold:ready']), comment: planCmd(), config })).outcome, 'admitted');
  assert.equal((await admit(admitGh(), 'o/r', { issue: issue(['scaffold:ready']), comment: planCmd({ author_association: 'NONE' }), config })).outcome, 'refused');
  assert.equal((await admit(admitGh(), 'o/r', { issue: issue(['scaffold:needs-info']), comment: planCmd(), config })).outcome, 'refused');
  assert.equal((await admit(admitGh(), 'o/r', { issue: issue(['scaffold:too-big']), comment: planCmd(), config })).outcome, 'refused');
  assert.equal((await admit(admitGh(), 'o/r', { issue: issue(['scaffold:ready']), comment: planCmd({ body: '/planet' }), config })).outcome, 'skipped');
});

test('the sweep finds recent /plan comments, oldest first', async () => {
  const since = '2026-11-20T10:00:00Z';
  const gh = fakeGh({
    '/repos/o/r/issues/comments': [
      { id: 1, body: '/plan', created_at: '2026-11-20T09:00:00Z', issue_url: 'https://api.github.com/repos/o/r/issues/4' },
      { id: 2, body: '/plan please', created_at: '2026-11-20T10:01:00Z', issue_url: 'https://api.github.com/repos/o/r/issues/5' },
      { id: 3, body: 'lgtm', created_at: '2026-11-20T10:02:00Z', issue_url: 'https://api.github.com/repos/o/r/issues/6' },
    ],
  });
  const found = await recentPlanComments(gh, 'o/r', since);
  assert.deepEqual(found.map((c) => c.id), [2]);
  assert.equal(issueNumber(found[0]), 5);
  assert.match(gh.calls[0][1], /since=2026-11-20T10%3A00%3A00Z&sort=created&direction=asc/);
});

// runPlan for issue 1, admitted from a manual handoff: `scaffold:planned` applied, no triage status comment.
async function planRun({ config = configFrom(PLAN_ONLY), configError, replies = [small], comments = [] } = {}) {
  const gh = fakeGh({
    '/repos/o/r/issues/comments/50': { id: 50, body: '/plan keep it small' },
    '/repos/o/r/issues/1/comments': comments,
    '/repos/o/r/issues/1/labels': null,
    '/repos/o/r/issues/1': { number: 1, title: 'T', body: 'B', labels: [{ name: 'scaffold:planned' }] },
    '/repos/o/r/contents/': new Error('GET: 404 Not Found'),
    '/repos/o/r/git/trees/': { tree: [{ type: 'blob', path: 'src/a.js' }] },
  });
  const prompts = [];
  const summary = await runPlan(gh, 'o/r', {
    event: { repository: { default_branch: 'main' } },
    issueNumber: 1,
    commentId: 50,
    config: configError ? undefined : config,
    configError,
    loadSkill: async () => ({ system: 'S', schema, version: '0.2.0', model: 'm' }),
    callModel: async ({ user }) => {
      prompts.push(user);
      return structuredClone(replies[Math.min(prompts.length - 1, replies.length - 1)]);
    },
  });
  const labelCalls = gh.calls.filter(([, path]) => path.includes('/labels')).map(([m, path, body]) => (m === 'DELETE' ? `-${decodeURIComponent(path.split('/').pop())}` : body.labels.map((l) => `+${l}`).join(' ')));
  const bodies = gh.calls.filter(([m, path]) => m === 'POST' && path.endsWith('/comments')).map(([, , b]) => b.body);
  return { summary, labelCalls, prompts, plan: bodies.find((b) => b.startsWith(PLAN_MARKER)), status: bodies.filter((b) => b.startsWith(MARKER)).at(-1) };
}

test('with intake off, a manually triaged issue is planned and the triage row shows manual', async () => {
  const { prompts, plan: body, status, labelCalls, summary } = await planRun();
  assert.match(prompts[0], /Stack limit: at most 5 PRs/);
  assert.match(prompts[0], /<untrusted_triage>\n\(none\)\n<\/untrusted_triage>/);
  assert.ok(body.includes('**Delivered as:** one PR'));
  assert.deepEqual(labelCalls, ['+scaffold:planned']);
  assert.match(status, /\| Triage \| ✋ manual \(`intake` stage off/);
  assert.match(status, /\| Approval \| ⏳ waiting for a listed approver \|/);
  assert.match(summary, /\| planned \|$/m);
});

test('a plan that needs more than max_stack_prs PRs is too big: out of flight and back to triage', async () => {
  const { prompts, plan: body, status, labelCalls, summary } = await planRun({ config: configFrom(`${BOTH}\nmax_stack_prs: 3`), replies: [stackOf(4), stackOf(4)] });
  assert.equal(prompts.length, 2, 'one retry to fit the stack limit');
  assert.match(prompts[1], /a stack of 4 PRs is more than 3/);
  assert.ok(body.includes('gone back to triage'));
  assert.deepEqual(labelCalls, ['-scaffold:planned', '+scaffold:too-big']);
  assert.match(status, /\| Plan \| 🧱 \[too big\]\(.*\): needs more than 3 PRs, back to triage \|/);
  assert.match(status, /\*\*Next:\*\* a member applies `scaffold:triage` to get smaller tickets proposed/);
  assert.match(summary, /too big: back to triage/);
});

test('a too-big plan is not retried, and with intake off the split is manual', async () => {
  const { prompts, labelCalls, status } = await planRun({ replies: [plan('too-big', [])] });
  assert.equal(prompts.length, 1);
  assert.deepEqual(labelCalls, ['-scaffold:planned', '+scaffold:too-big']);
  assert.match(status, /\*\*Next:\*\* split it into smaller tickets by hand: see `packages\/intake\/HANDOFF.md`/);
});

test('a stack that fits after the retry is planned', async () => {
  const { prompts, labelCalls, status } = await planRun({ config: configFrom(`${PLAN_ONLY}\nmax_stack_prs: 3`), replies: [stackOf(4), stackOf(3)] });
  assert.equal(prompts.length, 2);
  assert.deepEqual(labelCalls, ['+scaffold:planned']);
  assert.match(status, /stack of 3 PRs/);
});

test('an invalid scaffold-config.yml stops planning before the model call', async () => {
  const { prompts, labelCalls, status } = await planRun({ configError: '$.stages: expected object' });
  assert.deepEqual(prompts, []);
  assert.deepEqual(labelCalls, ['-scaffold:planned', '+scaffold:ready']);
  assert.match(status, /\| Plan \| ⚠️ `.github\/scaffold-config.yml` is invalid \|/);
});

test('status gates update one row and keep earlier details', () => {
  const body = setGates(`${MARKER}\n### SCAFFOLD status\n\n| Gate | State |\n| --- | --- |\n| Triage | ✅ ready |\n| Plan | ⏳ |\n| Approval | ⏳ |\n\n**Next:** x\n\nBrief`, { Plan: '📝 planned', Approval: '⏳ waiting' }, 'approve it.');
  assert.ok(body.includes('| Triage | ✅ ready |\n| Plan | 📝 planned |\n| Approval | ⏳ waiting |'));
  assert.equal(body.match(/\*\*Next:\*\*/g).length, 1);
  assert.ok(body.includes('**Next:** approve it.') && body.includes('Brief'));
});

test('the manual plan template produces a marked plan comment with the package\'s sections', async () => {
  const manual = await readFile(new URL('../templates/manual-plan.md', import.meta.url), 'utf8');
  assert.ok(manual.startsWith(`${PLAN_MARKER}\n### SCAFFOLD plan`));
  for (const h of ['#### Approach', '#### Acceptance criteria', '#### Affected paths', '#### Sub-tasks', '#### Risks']) assert.ok(manual.includes(h), h);
  // Limits are per repo: the template points at the config instead of quoting the defaults.
  assert.doesNotMatch(manual, /\b\d+ files\b|\b\d+ lines\b/);
  assert.match(manual, /pr_size\.soft/);
  assert.match(manual, /max_stack_prs/);
  const generated = planBody(small);
  for (const h of ['#### Approach', '#### Acceptance criteria', '#### Affected paths', '#### Sub-tasks']) assert.ok(generated.includes(h), h);
});

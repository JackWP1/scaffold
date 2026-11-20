import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '../actions/lib/validate.mjs';
import { parseYaml, configFrom, DEFAULTS } from '../actions/lib/config.mjs';
import { MARKER, setGates } from '../actions/lib/status.mjs';
import { loadSkill } from '../actions/lib/skills.mjs';
import { renderTriage } from '../actions/triage/render.mjs';
import { PLAN_MARKER, checkPlan, evaluateApproval, encodePlan, decodePlan, planHash } from '../actions/plan/rules.mjs';
import { renderPlan, renderSubTicket } from '../actions/plan/render.mjs';
import { createSubTickets } from '../actions/plan/subtickets.mjs';
import { runGate } from '../actions/plan/gate.mjs';
import { admit, recentPlanComments, issueNumber } from '../actions/plan/admission.mjs';
import { fakeGh } from './fake-github.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const schema = JSON.parse(await readFile(new URL('../schemas/plan.schema.json', import.meta.url), 'utf8'));
const limits = DEFAULTS.pr_size;

const task = (id, files, lines, blocked_by = []) => ({
  id, title: `Task ${id}`, description: 'Do it', blocked_by, acceptance_criteria: ['Works'], affected_paths: ['src/a.js'], estimate: { files, lines },
});
const plan = (split, subtasks, estimate = { files: 4, lines: 200 }) => ({
  approach: 'Change the thing', split, estimate, acceptance_criteria: ['It works'], affected_paths: ['src/**'], subtasks, risks: [],
});
const small = plan('none', [task('1', 2, 100), task('2', 2, 100, ['1'])]);

test('scaffold-config.yml subset parses nested maps and lists', () => {
  const yaml = '# c\napprovers:\n  - Alice\n  - bob # lead\nflow_lead: bob\nmax_in_flight: 12\npr_size:\n  soft:\n    files: 5\n  exempt: [a.lock, "dist/**"]\n';
  assert.deepEqual(parseYaml(yaml), {
    approvers: ['Alice', 'bob'], flow_lead: 'bob', max_in_flight: 12, pr_size: { soft: { files: 5 }, exempt: ['a.lock', 'dist/**'] },
  });
  const config = configFrom(yaml);
  assert.deepEqual(config.approvers, ['alice', 'bob']);
  assert.deepEqual(config.pr_size.soft, { files: 5, lines: 1000 });
  assert.deepEqual(config.pr_size.hard, DEFAULTS.pr_size.hard);
});

test('a missing scaffold-config.yml lists no approvers', () => {
  assert.deepEqual(configFrom('').approvers, []);
  assert.equal(configFrom('').max_in_flight, 20);
});

test('the scaffold-config.yml template parses', async () => {
  const config = configFrom(await readFile(new URL('../templates/caller/.github/scaffold-config.yml', import.meta.url), 'utf8'));
  assert.deepEqual(config.pr_size, DEFAULTS.pr_size);
  assert.equal(config.max_in_flight, 20);
});

test('task-decomposer skill loads with the standard tier', async () => {
  const skill = await loadSkill(root, 'task-decomposer');
  const models = await readFile(new URL('../config/models.yml', import.meta.url), 'utf8');
  assert.equal(skill.model, models.match(/^standard:\s*(\S+)/m)[1]);
  assert.equal(skill.version, '0.1.0');
  assert.deepEqual(skill.schema, schema);
  assert.ok(skill.system.includes('# Task decomposer'));
  assert.equal((await loadSkill(root, 'triage', 'override')).model, 'override');
});

test('valid plan output passes the schema; bad estimates do not', () => {
  assert.deepEqual(validate(schema, small), []);
  const bad = plan('none', [task('1', -1, 1.5)]);
  const errors = validate(schema, bad);
  assert.ok(errors.some((e) => e.includes('files: less than 0')));
  assert.ok(errors.some((e) => e.includes('lines: expected integer')));
});

test('size rules: unsplit work must fit the soft limit', () => {
  assert.deepEqual(checkPlan(small, limits), []);
  const big = plan('none', [task('1', 20, 3000)], { files: 20, lines: 3000 });
  assert.match(checkPlan(big, limits)[0], /over the soft limit .* not split/);
});

test('size rules: each split layer must fit, sub-tickets max 5, too-big is refused', () => {
  const est = { files: 20, lines: 3000 };
  assert.deepEqual(checkPlan(plan('stack', [task('1', 10, 900), task('2', 10, 900, ['1'])], est), limits), []);
  assert.match(checkPlan(plan('stack', [task('1', 11, 900), task('2', 9, 900)], est), limits)[0], /sub-task 1 .* over the soft limit/);
  const six = ['1', '2', '3', '4', '5', '6'].map((id) => task(id, 2, 100));
  assert.ok(checkPlan(plan('sub-tickets', six, est), limits).some((p) => p.includes('more than 5')));
  assert.ok(checkPlan(plan('sub-tickets', [task('1', 2, 100)], est), limits).some((p) => p.includes('at least 2')));
  assert.match(checkPlan(plan('too-big', [], est), limits)[0], /more than 5 sub-tickets/);
});

test('size rules: blocking edges must point to earlier sub-tasks', () => {
  const p = plan('none', [task('1', 1, 10, ['2']), task('2', 1, 10)]);
  assert.match(checkPlan(p, limits)[0], /blocked by 2, which is not an earlier sub-task/);
});

test('plan data round-trips through the comment and rejects tampering', () => {
  const body = renderPlan(small, { problems: [], skillVersion: '0.1.0', model: 'm', limits });
  assert.deepEqual(decodePlan(body, schema), small);
  assert.equal(decodePlan(body.replace(/plan-data \S+/, `plan-data ${Buffer.from('{"x":1}').toString('base64')}`), schema), null);
  assert.equal(decodePlan('no data', schema), null);
  assert.ok(encodePlan(small).startsWith('<!-- scaffold:plan-data '));
});

test('plan comment escapes model text and shows problems', () => {
  const evil = plan('none', [{ ...task('1', 1, 1), title: 'ping @admin', description: '<img src=x>' }]);
  evil.affected_paths = ['src/`x`\n@y'];
  const body = renderPlan(evil, { problems: ['estimate is over'], skillVersion: '0.1.0', model: 'm', limits });
  assert.ok(body.startsWith(PLAN_MARKER));
  assert.ok(!body.includes('@admin') && !body.includes('<img'));
  assert.ok(body.includes('- `src/ x @y`'));
  assert.ok(body.includes('> - estimate is over'));
});

test('sub-ticket body links the parent and earlier blockers', () => {
  const body = renderSubTicket(task('2', 1, 10, ['1']), { parent: 7, numbers: { 1: 8 } });
  assert.ok(body.startsWith('<!-- scaffold:sub-ticket 7/2 -->'));
  assert.ok(body.includes('Sub-ticket 2 of #7') && body.includes('- #8'));
});

const approved = (login, at = '2026-11-18T12:00:00Z', type = 'User') => ({ event: 'labeled', label: { name: 'scaffold:plan-approved' }, actor: { login, type }, created_at: at });
const planComment = { body: 'plan', updated_at: '2026-11-18T11:00:00Z' };
const gate = (over) => evaluateApproval({ events: [approved('Alice')], author: 'carol', approvers: ['alice'], planComment, plan: small, limits, ...over });

test('plan gate passes for a listed approver after the plan was posted', () => {
  assert.deepEqual(gate({}), { ok: true, approver: 'Alice', at: '2026-11-18T12:00:00Z', hash: planHash('plan') });
});

test('plan gate fails for the author, a bot, an unlisted user or no label', () => {
  assert.match(gate({ author: 'alice' }).reason, /author can't approve/);
  assert.match(gate({ events: [approved('alice', undefined, 'Bot')] }).reason, /bot/);
  assert.match(gate({ approvers: [] }).reason, /not a listed approver/);
  assert.match(gate({ events: [] }).reason, /was not applied/);
});

test('plan gate uses the latest approval event', () => {
  assert.equal(gate({ events: [approved('alice'), approved('mallory')] }).ok, false);
  assert.equal(gate({ events: [approved('mallory'), approved('alice')] }).ok, true);
});

test('plan gate fails if the plan changed after approval, is missing or breaks the size rules', () => {
  assert.match(gate({ planComment: { ...planComment, updated_at: '2026-11-18T12:00:01Z' } }).reason, /changed after it was approved/);
  assert.match(gate({ planComment: undefined }).reason, /no plan/);
  assert.match(gate({ plan: null }).reason, /missing or invalid/);
  assert.match(gate({ plan: plan('too-big', []) }).reason, /size rules/);
});

const bot = { login: 'github-actions[bot]' };

test('sub-tickets are created once each, linked as sub-issues, with blockers', async () => {
  let next = 10;
  const gh = fakeGh({
    '/repos/o/r/issues/7/sub_issues?': [{ id: 1009, number: 9, user: bot, body: '<!-- scaffold:sub-ticket 7/1 -->\nold' }],
    '/repos/o/r/issues/7/sub_issues': null,
    '/repos/o/r/issues/7/timeline': [],
    '/repos/o/r/issues': () => ({ id: 1000 + next, number: next++ }),
  });
  const p = plan('sub-tickets', [task('1', 2, 10), task('2', 2, 10, ['1']), task('3', 2, 10, ['2'])]);
  const { numbers, created } = await createSubTickets(gh, 'o/r', { number: 7 }, p, ['priority:high', 'scaffold:plan-approved']);
  assert.deepEqual(numbers, { 1: 9, 2: 10, 3: 11 });
  assert.deepEqual(created, [10, 11]);
  const posts = gh.calls.filter(([m]) => m === 'POST');
  assert.deepEqual(posts.map(([, path]) => path), ['/repos/o/r/issues', '/repos/o/r/issues/7/sub_issues', '/repos/o/r/issues', '/repos/o/r/issues/7/sub_issues']);
  assert.deepEqual(posts[0][2].labels, ['priority:high']);
  assert.ok(posts[0][2].body.includes('- #9'));
  assert.deepEqual(posts[1][2], { sub_issue_id: 1010 });
});

test('a retry links a sub-ticket created but not linked last time, and ignores look-alikes', async () => {
  const orphan = { id: 1009, number: 9, user: bot, body: '<!-- scaffold:sub-ticket 7/1 -->\nx' };
  const fake = { id: 1008, number: 8, user: { login: 'mallory' }, body: '<!-- scaffold:sub-ticket 7/2 -->\nx' };
  const gh = fakeGh({
    '/repos/o/r/issues/7/sub_issues?': [],
    '/repos/o/r/issues/7/sub_issues': null,
    '/repos/o/r/issues/7/timeline': [{ event: 'cross-referenced', source: { issue: orphan } }, { event: 'cross-referenced', source: { issue: fake } }],
    '/repos/o/r/issues': { id: 1010, number: 10 },
  });
  const { numbers, created } = await createSubTickets(gh, 'o/r', { number: 7 }, plan('sub-tickets', [task('1', 2, 10), task('2', 2, 10)]), []);
  assert.deepEqual(numbers, { 1: 9, 2: 10 });
  assert.deepEqual(created, [10]);
  const posts = gh.calls.filter(([m]) => m === 'POST').map(([, path, body]) => [path, body.sub_issue_id]);
  assert.deepEqual(posts, [['/repos/o/r/issues/7/sub_issues', 1009], ['/repos/o/r/issues', undefined], ['/repos/o/r/issues/7/sub_issues', 1010]]);
});

// Gate runs against a fake issue. `planBody` is the bot's plan comment, if any.
async function gateRun({ action = 'labeled', labels = ['scaffold:plan-approved'], planBody, events = [approved('alice')], subIssues = null, comment } = {}) {
  const comments = planBody ? [{ id: 5, user: bot, body: planBody, updated_at: '2026-11-18T11:00:00Z', html_url: 'u' }] : [];
  const gh = fakeGh({
    '/repos/o/r/issues/1/comments': comments,
    '/repos/o/r/issues/1/events': events,
    '/repos/o/r/issues/1/sub_issues?': [],
    '/repos/o/r/issues/1/sub_issues': subIssues,
    '/repos/o/r/issues/1/timeline': [],
    '/repos/o/r/issues': { id: 1, number: 2 },
  });
  const event = {
    action,
    label: action === 'labeled' ? { name: 'scaffold:plan-approved' } : undefined,
    comment,
    issue: { number: 1, user: { login: 'carol' }, labels: labels.map((name) => ({ name })) },
  };
  const out = await runGate(gh, 'o/r', { event, schema, config: configFrom('approvers: [alice]') });
  const labelCalls = gh.calls.filter(([m, path]) => path.includes('/labels')).map(([m, path, body]) => (m === 'DELETE' ? `-${decodeURIComponent(path.split('/').pop())}` : body.labels.map((l) => `+${l}`).join(' ')));
  const status = gh.calls.filter(([m, path]) => path.endsWith('/comments') || path.includes('/issues/comments/')).filter(([m]) => m !== 'GET').at(-1)?.[2]?.body;
  return { out, labelCalls, status };
}
const planBody = (p) => renderPlan(p, { problems: [], skillVersion: '0.1.0', model: 'm', limits });

test('gate passes a valid approval and drops scaffold:planned', async () => {
  const { out, labelCalls } = await gateRun({ labels: ['scaffold:planned', 'scaffold:plan-approved'], planBody: planBody(small) });
  assert.ok(out.lines.some((l) => l.includes('| pass |')));
  assert.deepEqual(labelCalls, ['-scaffold:planned']);
});

test('deleting the plan comment withdraws approval and goes back to Ready', async () => {
  const deleted = { body: `${PLAN_MARKER}\nold`, user: bot };
  for (const labels of [['scaffold:plan-approved'], ['scaffold:planned']]) {
    const { out, labelCalls, status } = await gateRun({ action: 'deleted', comment: deleted, labels });
    assert.match(out.lines.join('\n'), /approval withdrawn/);
    assert.ok(labelCalls.includes('+scaffold:ready'));
    assert.ok(labelCalls.includes(`-${labels[0]}`));
    assert.match(status, /\| Plan \| 🗑️ plan deleted \|/);
  }
  assert.equal((await gateRun({ action: 'deleted', comment: { body: 'hi' } })).out.skip, 'comment is not the plan');
});

test('an approval with no plan comment also goes back to Ready', async () => {
  const { labelCalls } = await gateRun();
  assert.deepEqual(labelCalls, ['-scaffold:plan-approved', '+scaffold:ready']);
});

test('approval is withheld when a sub-ticket cannot be created', async () => {
  const split = plan('sub-tickets', [task('1', 2, 10), task('2', 2, 10)], { files: 12, lines: 20 });
  const { out, labelCalls, status } = await gateRun({ labels: ['scaffold:planned', 'scaffold:plan-approved'], planBody: planBody(split), subIssues: new Error('POST sub_issues: 403') });
  assert.match(out.lines.join('\n'), /fail: sub-tickets could not all be created/);
  assert.deepEqual(labelCalls, ['-scaffold:plan-approved', '+scaffold:planned']);
  assert.match(status, /\| Approval \| ❌ not approved: sub-tickets/);
});

test('a plan with no sub-tasks is not approvable', () => {
  assert.deepEqual(checkPlan(plan('none', []), limits), ['the plan has no sub-tasks']);
  assert.match(gate({ plan: plan('none', []) }).reason, /no sub-tasks/);
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
  const r = await admit(gh, 'o/r', { issue: issue(['scaffold:ready', 'scaffold:plan-approved']), comment: planCmd(), config: configFrom('') });
  assert.equal(r.outcome, 'admitted');
  assert.deepEqual(posted(gh, '/reactions'), [{ content: 'eyes' }]);
  assert.deepEqual(posted(gh, '/labels'), [{ labels: ['scaffold:planned'] }]);
  assert.ok(gh.calls.some(([m, path]) => m === 'DELETE' && path.endsWith('scaffold%3Aplan-approved')));
});

test('admission refuses at the in-flight limit, counting other issues once', async () => {
  const gh = admitGh({ inFlightIssues: [{ number: 2 }, { number: 3, pull_request: {} }, { number: 1 }] });
  const r = await admit(gh, 'o/r', { issue: issue(['scaffold:ready']), comment: planCmd(), config: configFrom('max_in_flight: 1') });
  assert.equal(r.outcome, 'refused');
  assert.equal(r.reason, '1 of 1 tickets in flight');
  assert.deepEqual(posted(gh, '/reactions'), [{ content: 'confused' }]);
  assert.match(posted(gh, '/comments')[0].body, /\| Plan \| ⏸️ waiting: 1 of 1 tickets in flight \|/);
});

test('admission skips handled comments and refuses non-members or unready issues', async () => {
  const done = admitGh({ reactions: [{ user: bot, content: 'eyes' }] });
  assert.equal((await admit(done, 'o/r', { issue: issue(['scaffold:ready']), comment: planCmd(), config: configFrom('') })).reason, 'already handled');
  assert.deepEqual(posted(done, '/reactions'), []);
  const other = admitGh({ reactions: [{ user: { login: 'bob' }, content: 'eyes' }] });
  assert.equal((await admit(other, 'o/r', { issue: issue(['scaffold:ready']), comment: planCmd(), config: configFrom('') })).outcome, 'admitted');
  assert.equal((await admit(admitGh(), 'o/r', { issue: issue(['scaffold:ready']), comment: planCmd({ author_association: 'NONE' }), config: configFrom('') })).outcome, 'refused');
  assert.equal((await admit(admitGh(), 'o/r', { issue: issue(['scaffold:needs-info']), comment: planCmd(), config: configFrom('') })).outcome, 'refused');
  assert.equal((await admit(admitGh(), 'o/r', { issue: issue(['scaffold:ready']), comment: planCmd({ body: '/planet' }), config: configFrom('') })).outcome, 'skipped');
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

test('workflows: admission is repo-wide, planning per issue, and plan deletion reaches the gate', async () => {
  const wf = await readFile(new URL('../.github/workflows/plan.yml', import.meta.url), 'utf8');
  assert.match(wf, /group: scaffold-admit-\$\{\{ github\.repository \}\}\n/);
  assert.match(wf, /group: scaffold-plan-\$\{\{ github\.repository \}\}-\$\{\{ matrix\.issue \}\}/);
  assert.match(wf, /\["edited","deleted"\]/);
  const caller = await readFile(new URL('../templates/caller/.github/workflows/scaffold.yml', import.meta.url), 'utf8');
  assert.match(caller, /issue_comment:\n\s+types: \[created, edited, deleted\]/);
});

test('status gates update one row and keep the triage details', () => {
  const triage = renderTriage({
    decision: 'ready', type: 'bug', priority: 'low', summary: 's', questions: [],
    brief: { goal: 'g', acceptance_criteria: [], affected_areas: [], out_of_scope: [] },
  }, { skillVersion: '0.1.0', model: 'm' });
  const body = setGates(triage, { Plan: '📝 planned', Approval: '⏳ waiting' }, 'approve it.');
  assert.ok(body.includes('| Triage | ✅ ready |\n| Plan | 📝 planned |\n| Approval | ⏳ waiting |'));
  assert.equal(body.match(/\*\*Next:\*\*/g).length, 1);
  assert.ok(body.includes('**Next:** approve it.') && body.includes('Agent-ready brief'));
  assert.ok(setGates(body, { Plan: 'x $& y' }).includes('| Plan | x $& y |'));
});

test('status gates add a table when there is none', () => {
  const body = setGates(undefined, { Plan: '⏸️ waiting' }, 'wait.');
  assert.ok(body.startsWith(MARKER));
  assert.ok(body.includes('| Triage | ⏳ pending |\n| Plan | ⏸️ waiting |\n| Approval | ⏳ pending |\n\n**Next:** wait.'));
});

test('plan, admit and gate entry points parse', () => {
  for (const f of ['../actions/plan/plan.mjs', '../actions/plan/admit.mjs', '../actions/plan-gate/gate.mjs']) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(f, import.meta.url))]);
  }
});

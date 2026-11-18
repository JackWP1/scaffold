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

test('sub-tickets are created once each, linked as sub-issues, with blockers', async () => {
  let next = 10;
  const gh = fakeGh({
    '/repos/o/r/issues/7/sub_issues?': [{ number: 9, body: '<!-- scaffold:sub-ticket 7/1 -->\nold' }],
    '/repos/o/r/issues/7/sub_issues': null,
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

test('plan and gate entry points parse', () => {
  for (const f of ['../actions/plan/plan.mjs', '../actions/plan-gate/gate.mjs']) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(f, import.meta.url))]);
  }
});

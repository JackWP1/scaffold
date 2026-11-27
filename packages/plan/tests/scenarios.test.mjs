// The plan package with scenarios required and intake off: the scenarios comment is the manual one a
// human writes from packages/intake/templates/manual-gherkin.md, and plan re-checks its approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configFrom, DEFAULTS } from '../../core/lib/config.mjs';
import { MARKER } from '../../core/lib/status.mjs';
import { tagScenarios, SCENARIOS_MARKER } from '../../core/lib/gherkin.mjs';
import { commentHash } from '../../core/lib/approval.mjs';
import { checkScenarios, scenariosRequired } from '../../core/lib/scenarios.mjs';
import { fakeGh } from '../../core/tests/fake-github.mjs';
import { PLAN_MARKER, checkPlan, planScenarios } from '../rules.mjs';
import { renderPlan } from '../render.mjs';
import { runGate } from '../gate.mjs';
import { runPlan } from '../planner.mjs';
import { admit } from '../admission.mjs';

const schema = JSON.parse(await readFile(new URL('../schemas/plan.schema.json', import.meta.url), 'utf8'));
const limits = DEFAULTS.pr_size;
const BDD = 'bdd:\n  workflow: ci.yml\n  artifact: r';
const ALWAYS = configFrom(`stages:\n  plan: true\napprovers: [alice]\ngherkin: always\n${BDD}`);
const AUTO = configFrom(`stages:\n  plan: true\napprovers: [alice]\ngherkin: auto\n${BDD}`);
const bot = { login: 'github-actions[bot]' };

const GHERKIN = 'Feature: Login\n  Scenario: Correct password\n    When ada signs in\n    Then she sees her dashboard\n  Scenario: Wrong password\n    When ada mistypes\n    Then she sees an error';
const manualScenarios = (gherkin = GHERKIN) => `${SCENARIOS_MARKER}\n### SCAFFOLD scenarios\n\n\`\`\`gherkin\n${tagScenarios(gherkin, 1).text ?? gherkin}\n\`\`\``;
const scenariosComment = (body = manualScenarios()) => ({ id: 3, user: { login: 'dave' }, author_association: 'MEMBER', body, updated_at: '2026-11-18T09:00:00Z', html_url: 's' });
const gherkinApproved = { id: 2, event: 'labeled', label: { name: 'scaffold:gherkin-approved' }, actor: { login: 'alice', type: 'User' }, created_at: '2026-11-18T10:00:00Z' };
const planApproved = { id: 7, event: 'labeled', label: { name: 'scaffold:plan-approved' }, actor: { login: 'alice', type: 'User' }, created_at: '2026-11-18T12:00:00Z' };

const task = (id, scenarios, blocked_by = []) => ({
  id, title: `Task ${id}`, description: 'Do it', blocked_by, acceptance_criteria: [], affected_paths: [], estimate: { files: 5, lines: 500 }, scenarios,
});
const stack = (...maps) => ({
  approach: 'a', split: 'stack', estimate: { files: 10, lines: 1000 }, acceptance_criteria: [], affected_paths: [], risks: [],
  subtasks: maps.map((m, i) => task(String(i + 1), m, i ? [String(i)] : [])),
});
const one = (...maps) => ({ ...stack(...maps), split: 'none', estimate: { files: 4, lines: 200 }, subtasks: stack(...maps).subtasks.map((t) => ({ ...t, estimate: { files: 2, lines: 100 } })) });

test('scenarios are required under always, and under auto once either scenarios label is on', () => {
  assert.equal(scenariosRequired(ALWAYS, []), true);
  assert.equal(scenariosRequired(AUTO, ['scaffold:ready']), false);
  assert.equal(scenariosRequired(AUTO, ['scaffold:ready', 'scaffold:gherkin-approved']), true);
  assert.equal(scenariosRequired(configFrom('stages:\n  plan: true'), ['scaffold:gherkin-approved']), false);
});

test('core scenario check: approved, parsed and tagged S1..Sn for this issue', () => {
  const check = (body, issue = 1) => checkScenarios({ events: [gherkinApproved], issue, author: 'carol', approvers: ['alice'], comments: [scenariosComment(body)] });
  const ok = check(manualScenarios());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ids, ['S1', 'S2']);
  assert.equal(ok.hash, commentHash(manualScenarios()));
  assert.match(check(manualScenarios(), 2).reason, /scenario 1 isn't tagged `@scaffold-2-S1`/);
  assert.match(check(`${SCENARIOS_MARKER}\n\`\`\`gherkin\n${GHERKIN}\n\`\`\``).reason, /scenario 1 isn't tagged/);
});

test('plan rules: a stack maps each scenario to exactly one PR; one PR maps each at least once', () => {
  const ids = ['S1', 'S2'];
  assert.deepEqual(checkPlan(stack(['S1'], ['S2']), limits, 5, ids), []);
  assert.deepEqual(checkPlan(stack(['S1'], ['S1']), limits, 5, ids), ['scenario S1 is mapped to more than one PR (1, 2)', 'scenario S2 is not mapped to a PR']);
  assert.deepEqual(checkPlan(stack(['S1', 'S9'], ['S2']), limits, 5, ids), ['sub-task 1 maps S9, which is not an approved scenario']);
  assert.deepEqual(checkPlan(one(['S1', 'S2'], ['S2']), limits, 5, ids), []);
  assert.deepEqual(checkPlan(one([], []), limits, 5, ids), ['scenario S1 is not mapped to a sub-task', 'scenario S2 is not mapped to a sub-task']);
  assert.deepEqual(checkPlan(stack(undefined, undefined), limits, 5, []), [], 'no scenarios required: mappings ignored');
});

function gh({ labels, comments, events, extra = {} }) {
  return fakeGh({
    '/repos/o/r/issues/comments/50/reactions': (path) => (path.includes('page=') ? [] : {}),
    '/repos/o/r/issues/comments/50': { id: 50, body: '/plan' },
    '/repos/o/r/issues?state=open': [],
    '/repos/o/r/issues/1/comments': (path) => (path.includes('page=') ? comments : { html_url: 'p' }),
    '/repos/o/r/issues/1/events': events,
    '/repos/o/r/issues/1/labels': null,
    '/repos/o/r/issues/1': { number: 1, title: 'T', body: 'B', user: { login: 'carol' }, labels: labels.map((name) => ({ name })) },
    '/repos/o/r/contents/': new Error('GET: 404 Not Found'),
    '/repos/o/r/git/trees/': { tree: [] },
    ...extra,
  });
}
const posts = (g) => g.calls.filter(([m, path]) => m !== 'GET' && (path.endsWith('/comments') || path.includes('/issues/comments/'))).map(([, , b]) => b?.body).filter(Boolean);
const labelCalls = (g) => g.calls.filter(([, path]) => path.includes('/labels')).map(([m, path, body]) => (m === 'DELETE' ? `-${decodeURIComponent(path.split('/').pop())}` : body.labels.map((l) => `+${l}`).join(' ')));

test('admission refuses /plan until the scenarios are approved on the timeline, not by label', async () => {
  const issue = { number: 1, user: { login: 'carol' }, labels: [{ name: 'scaffold:ready' }, { name: 'scaffold:gherkin-approved' }] };
  const comment = { id: 50, body: '/plan', author_association: 'MEMBER', user: { type: 'User' } };
  const forged = gh({ labels: [], comments: [scenariosComment()], events: [{ ...gherkinApproved, actor: { login: 'carol', type: 'User' } }] });
  const r = await admit(forged, 'o/r', { issue, comment, config: AUTO });
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /scenarios not approved: the issue author can't approve/);
  assert.match(posts(forged).at(-1), /\| Plan \| ⛔ the scenarios aren't approved: the issue author can't approve their own issue \|/);
  assert.deepEqual(labelCalls(forged), []);
  const ok = gh({ labels: [], comments: [scenariosComment()], events: [gherkinApproved] });
  assert.equal((await admit(ok, 'o/r', { issue, comment, config: AUTO })).outcome, 'admitted');
});

async function planRun({ replies, comments = [scenariosComment()], events = [gherkinApproved] }) {
  const g = gh({ labels: ['scaffold:planned'], comments, events });
  const prompts = [];
  const summary = await runPlan(g, 'o/r', {
    event: { repository: { default_branch: 'main' } }, issueNumber: 1, commentId: 50, config: ALWAYS,
    loadSkill: async () => ({ system: 'S', schema, version: '0.3.0', model: 'm' }),
    callModel: async ({ user }) => {
      prompts.push(user);
      return structuredClone(replies[Math.min(prompts.length - 1, replies.length - 1)]);
    },
  });
  const bodies = posts(g);
  return { summary, prompts, labelCalls: labelCalls(g), plan: bodies.find((b) => b.startsWith(PLAN_MARKER)), status: bodies.filter((b) => b.startsWith(MARKER)).at(-1) };
}

test('the planner gives the model the approved scenarios and records which ones the plan used', async () => {
  const { prompts, plan, status } = await planRun({ replies: [one(['S1'], []), one(['S1'], ['S2'])] });
  assert.match(prompts[0], /Approved scenarios: S1, S2\. Map every one/);
  assert.match(prompts[0], /<untrusted_scenarios>\nFeature: Login\n  @scaffold-1-S1/);
  assert.match(prompts[1], /scenario S2 is not mapped to a sub-task/);
  assert.match(plan, /Scenarios: S1\n/);
  assert.equal(planScenarios(plan), commentHash(manualScenarios()));
  assert.match(status, /\| Approval \| ⏳ waiting for a listed approver \|/);
});

test('the planner refuses before the model call when the scenarios aren\'t approved', async () => {
  const { prompts, labelCalls: calls, status } = await planRun({ replies: [one(['S1', 'S2'])], events: [] });
  assert.deepEqual(prompts, []);
  assert.deepEqual(calls, ['-scaffold:planned', '+scaffold:ready']);
  assert.match(status, /\| Plan \| ⚠️ the scenarios aren't approved: `scaffold:gherkin-approved` was not applied \|/);
});

async function gateRun({ plan = one(['S1', 'S2']), hash = commentHash(manualScenarios()), comments, events = [gherkinApproved, planApproved] }) {
  const body = renderPlan(plan, { problems: [], skillVersion: '0.3.0', model: 'm', limits, maxStack: 5, scenariosHash: hash });
  const planComment = { id: 5, user: bot, body, updated_at: '2026-11-18T11:00:00Z', html_url: 'u' };
  const g = gh({ labels: ['scaffold:planned', 'scaffold:plan-approved'], comments: comments ?? [scenariosComment(), planComment], events });
  const out = await runGate(g, 'o/r', { event: { action: 'labeled', label: { name: 'scaffold:plan-approved' }, issue: { number: 1 } }, schema, config: ALWAYS });
  return { text: out.lines.join('\n'), labelCalls: labelCalls(g) };
}

test('the plan gate passes a plan made against the approved scenarios, mapping each', async () => {
  const { text, labelCalls: calls } = await gateRun({});
  assert.match(text, /\| pass \|/);
  assert.deepEqual(calls, ['-scaffold:planned']);
});

test('the plan gate fails when the scenarios changed, lost approval, or aren\'t all mapped', async () => {
  assert.match((await gateRun({ hash: 'ffffffffffffffff' })).text, /fail: the scenarios changed since this plan was made: comment `\/plan` again/);
  assert.match((await gateRun({ hash: null })).text, /fail: the scenarios changed since this plan was made/);
  assert.match((await gateRun({ events: [planApproved] })).text, /fail: the scenarios aren't approved: `scaffold:gherkin-approved` was not applied/);
  assert.match((await gateRun({ plan: one(['S1'], []) })).text, /fail: the plan fails the size rules: scenario S2 is not mapped to a sub-task/);
});

test('only SCAFFOLD\'s or a member\'s comment counts as the scenarios', async () => {
  const { scenarioComments } = await import('../../core/lib/scenarios.mjs');
  const body = manualScenarios();
  const g = fakeGh({ '/repos/o/r/issues/1/comments': [
    { id: 1, user: bot, body }, { id: 2, user: { login: 'm' }, author_association: 'MEMBER', body },
    { id: 3, user: { login: 'x' }, author_association: 'NONE', body }, { id: 4, user: bot, body: 'other' },
  ] });
  assert.deepEqual((await scenarioComments(g, 'o/r', 1)).map((c) => c.id), [1, 2]);
});

test('a scenarios approval removed by hand blocks /plan on a planned issue', async () => {
  const issue = { number: 1, user: { login: 'carol' }, labels: [{ name: 'scaffold:planned' }, { name: 'scaffold:needs-gherkin' }] };
  const comment = { id: 50, body: '/plan', author_association: 'MEMBER', user: { type: 'User' } };
  const removed = { id: 4, event: 'unlabeled', label: { name: 'scaffold:gherkin-approved' }, actor: { login: 'bob', type: 'User' }, created_at: '2026-11-18T11:00:00Z' };
  const g = gh({ labels: [], comments: [scenariosComment()], events: [gherkinApproved, removed] });
  const r = await admit(g, 'o/r', { issue, comment, config: AUTO });
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /`scaffold:gherkin-approved` was removed after it was applied/);
});

test('with intake off, editing the hand-written scenarios comment withdraws an approved plan', async () => {
  const body = renderPlan(one(['S1', 'S2']), { problems: [], skillVersion: '0.3.0', model: 'm', limits, maxStack: 5, scenariosHash: commentHash(manualScenarios()) });
  const planComment = { id: 5, user: bot, body, updated_at: '2026-11-18T11:00:00Z', html_url: 'u' };
  const edited = { ...scenariosComment(), updated_at: '2026-11-18T13:00:00Z' };
  const run = async (labels) => {
    const g = gh({ labels, comments: [edited, planComment], events: [gherkinApproved, planApproved] });
    const out = await runGate(g, 'o/r', { event: { action: 'edited', comment: { body: edited.body }, issue: { number: 1 } }, schema, config: ALWAYS });
    return { out, labelCalls: labelCalls(g) };
  };
  const { out, labelCalls: calls } = await run(['scaffold:plan-approved']);
  assert.match(out.lines.join('\n'), /fail: the scenarios aren't approved: the scenarios changed after it was approved/);
  assert.deepEqual(calls, ['-scaffold:plan-approved', '+scaffold:planned']);
  assert.match((await run(['scaffold:planned'])).out.skip, /no approved plan to withdraw/);
});

test('under auto, a person revoking the approval keeps scenarios required until something resets it', () => {
  const human = { login: 'bob', type: 'User' };
  const ev = (event, name, actor = human) => ({ event, label: { name }, actor });
  const revoked = [ev('labeled', 'scaffold:gherkin-approved'), ev('unlabeled', 'scaffold:gherkin-approved')];
  assert.equal(scenariosRequired(AUTO, ['scaffold:ready'], revoked), true);
  assert.equal(scenariosRequired(AUTO, ['scaffold:ready'], [...revoked, ev('labeled', 'scaffold:triage')]), false, 're-triage resets');
  assert.equal(scenariosRequired(AUTO, ['scaffold:ready'], [...revoked, ev('labeled', 'scaffold:needs-gherkin'), ev('unlabeled', 'scaffold:needs-gherkin')]), false, 'member override');
  assert.equal(scenariosRequired(AUTO, ['scaffold:ready'], [ev('unlabeled', 'scaffold:gherkin-approved', { login: 'github-actions[bot]', type: 'Bot' })]), false, 'SCAFFOLD\'s removals don\'t count');
});

test('/plan in the moment after a person revokes the approval is still refused', async () => {
  const issue = { number: 1, user: { login: 'carol' }, labels: [{ name: 'scaffold:ready' }] };
  const comment = { id: 50, body: '/plan', author_association: 'MEMBER', user: { type: 'User' } };
  const removed = { id: 4, event: 'unlabeled', label: { name: 'scaffold:gherkin-approved' }, actor: { login: 'bob', type: 'User' }, created_at: '2026-11-18T11:00:00Z' };
  const r = await admit(gh({ labels: [], comments: [scenariosComment()], events: [gherkinApproved, removed] }), 'o/r', { issue, comment, config: AUTO });
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /was removed after it was applied/);
});

test('with intake off, removing scaffold:gherkin-approved withdraws an approved plan', async () => {
  const body = renderPlan(one(['S1', 'S2']), { problems: [], skillVersion: '0.3.0', model: 'm', limits, maxStack: 5, scenariosHash: commentHash(manualScenarios()) });
  const planComment = { id: 5, user: bot, body, updated_at: '2026-11-18T11:00:00Z', html_url: 'u' };
  const removed = { id: 9, event: 'unlabeled', label: { name: 'scaffold:gherkin-approved' }, actor: { login: 'bob', type: 'User' }, created_at: '2026-11-18T13:00:00Z' };
  const g = gh({ labels: ['scaffold:plan-approved'], comments: [scenariosComment(), planComment], events: [gherkinApproved, planApproved, removed] });
  const out = await runGate(g, 'o/r', { event: { action: 'unlabeled', label: { name: 'scaffold:gherkin-approved' }, issue: { number: 1 } }, schema, config: AUTO });
  assert.match(out.lines.join('\n'), /fail: the scenarios aren't approved: `scaffold:gherkin-approved` was removed after it was applied/);
  assert.deepEqual(labelCalls(g), ['-scaffold:plan-approved', '+scaffold:planned']);
  const other = await runGate(gh({ labels: [], comments: [], events: [] }), 'o/r', { event: { action: 'unlabeled', label: { name: 'scaffold:ready' }, issue: { number: 1 } }, schema, config: AUTO });
  assert.match(other.skip, /label is not scaffold:gherkin-approved/);
});

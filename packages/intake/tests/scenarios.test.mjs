import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configFrom } from '../../core/lib/config.mjs';
import { scenariosText } from '../../core/lib/gherkin.mjs';
import { fakeGh } from '../../core/tests/fake-github.mjs';
import { renderScenarios, SCENARIOS_MARKER } from '../scenarios.mjs';
import { runTriage } from '../triage.mjs';
import { runScenariosGate } from '../gate.mjs';

const schema = JSON.parse(await readFile(new URL('../schemas/triage.schema.json', import.meta.url), 'utf8'));
const cfg = (mode, extra = '') => configFrom(`stages:\n  intake: true\n  plan: true\ngherkin: ${mode}\nbdd:\n  workflow: ci.yml\n  artifact: r\napprovers: [alice]\n${extra}`);
const AUTO = cfg('auto');
const ALWAYS = cfg('always');
const OFF = configFrom('stages:\n  intake: true\n  plan: true\napprovers: [alice]');
const GHERKIN = 'Feature: Login\n  Scenario: Correct password\n    When ada signs in\n    Then she sees her dashboard';
const bot = { login: 'github-actions[bot]' };
const form = (gherkin) => `### Jira key\n\nABC-1\n\n### Kind\n\nFeature\n\n### What and why\n\nx\n\n### Done when\n\ny\n\n### Scenarios (Gherkin)\n\n${gherkin}`;

const labelCallsOf = (gh) => gh.calls.filter(([, path]) => path.includes('/labels')).map(([m, path, body]) => (m === 'DELETE' ? `-${decodeURIComponent(path.split('/').pop())}` : body.labels.map((l) => `+${l}`).join(' ')));
const postedOf = (gh) => gh.calls.filter(([m, path]) => m !== 'GET' && (path.endsWith('/comments') || path.includes('/issues/comments/'))).map(([, , b]) => b.body);

test('the scenarios comment numbers scenarios, escapes names and can\'t be broken out of', () => {
  const gherkin = 'Feature: f\n  Scenario: ping @admin | <b>\n    Given ```x```\n  Scenario: two\n    Given y';
  const { body, count } = renderScenarios(gherkin, { issue: 7, source: 'test', approvers: ['alice'] });
  assert.equal(count, 2);
  assert.ok(body.startsWith(SCENARIOS_MARKER));
  assert.match(body, /\| S1 \| ping @​admin \\\| &lt;b&gt; \|\n\| S2 \| two \|/);
  assert.match(body, /````gherkin\n/);
  assert.match(scenariosText(body), /@scaffold-7-S1\n  Scenario: ping @admin/);
  assert.match(body, /\(`alice`\) who isn't the issue author/);
  assert.deepEqual(renderScenarios('nope', { issue: 7, source: 'x' }).errors, ['line 1: expected `Feature:` first']);
});

// runTriage with a ready reply. `needed` is the model's scenarios_needed.
async function triage({ config = AUTO, needed = true, body = 'B', comments = [] } = {}) {
  const gh = fakeGh({ '/repos/o/r/issues/1/comments': comments, '/repos/o/r/issues/1/labels': null, '/repos/o/r/issues/comments/': { html_url: 'c' } });
  const reply = { decision: 'ready', type: 'feature', priority: 'medium', summary: 's', questions: [], brief: { goal: 'g', acceptance_criteria: [], affected_areas: [], out_of_scope: [] }, proposed_tickets: [], scenarios_needed: needed };
  const summary = await runTriage(gh, 'o/r', {
    event: { action: 'opened', issue: { number: 1, title: 'T', body, author_association: 'MEMBER', labels: [] } },
    config,
    loadSkill: async () => ({ system: 'S', schema, version: '0.3.0', model: 'm' }),
    callModel: async () => structuredClone(reply),
  });
  const posted = postedOf(gh);
  return { summary, labelCalls: labelCallsOf(gh), posted, status: posted.at(-1) };
}

test('triage: with scenarios needed, the form\'s Gherkin goes in the scenarios comment and the issue needs approval', async () => {
  const { labelCalls, posted, status, summary } = await triage({ body: form(`\`\`\`gherkin\n${GHERKIN}\n\`\`\``) });
  assert.equal(labelCalls.at(-1), '+scaffold:needs-gherkin +priority:medium');
  const scenarios = posted.find((b) => b.startsWith(SCENARIOS_MARKER));
  assert.match(scenariosText(scenarios), /@scaffold-1-S1\n  Scenario: Correct password/);
  assert.match(status, /\| Triage \| ✅ triaged: scenarios needed \|/);
  assert.match(status, /\| Scenarios \| 📝 \[1 scenario\]\(.*\): waiting for a listed approver \|/);
  assert.match(status, /\| Plan \| ⏳ waiting for approved scenarios \|/);
  assert.match(status, /\*\*Next:\*\* a listed approver reviews the scenarios and applies `scaffold:gherkin-approved`/);
  assert.match(summary, /\| needs-gherkin \|/);
});

test('triage: Gherkin that doesn\'t parse isn\'t posted; the status says why', async () => {
  const { labelCalls, posted, status } = await triage({ body: form('Scenario: no feature\n  Given x') });
  assert.ok(labelCalls.at(-1).startsWith('+scaffold:needs-gherkin'));
  assert.ok(!posted.some((b) => b.startsWith(SCENARIOS_MARKER)));
  assert.match(status, /\| Scenarios \| ⚠️ the Scenarios \(Gherkin\) field doesn't parse: line 1: expected `Feature:` first/);
});

test('triage: always requires scenarios whatever the model says; auto follows it; off ignores them', async () => {
  const always = await triage({ config: ALWAYS, needed: false });
  assert.ok(always.labelCalls.at(-1).startsWith('+scaffold:needs-gherkin'));
  assert.match(always.status, /\| Scenarios \| ⏳ no scenarios yet \|/);
  const auto = await triage({ needed: false });
  assert.ok(auto.labelCalls.at(-1).startsWith('+scaffold:ready'));
  assert.match(auto.status, /\| Scenarios \| ➖ not needed \(triage decided; a member can add `scaffold:needs-gherkin`\) \|/);
  const off = await triage({ config: OFF, needed: true, body: form(GHERKIN) });
  assert.ok(off.labelCalls.at(-1).startsWith('+scaffold:ready'));
  assert.ok(!off.posted.some((b) => b.startsWith(SCENARIOS_MARKER)));
  assert.match(off.status, /\| Scenarios \| ➖ not used \(`gherkin: off`\) \|/);
});

// The scenarios gate against a fake issue.
const scenariosComment = (over = {}) => ({ id: 5, user: bot, body: renderScenarios(GHERKIN, { issue: 1, source: 'test' }).body, updated_at: '2026-01-01T00:00:00Z', html_url: 'u', ...over });
const applied = (login = 'alice', at = '2026-01-02T00:00:00Z') => ({ id: 10, event: 'labeled', label: { name: 'scaffold:gherkin-approved' }, actor: { login, type: 'User' }, created_at: at });
const labelled = (action, name) => ({ action, label: { name } });

async function gate({ labels, event, comments = [scenariosComment()], events = [applied()], config = AUTO, configError, permission = 'write', sender = 'bob' }) {
  const gh = fakeGh({
    '/repos/o/r/issues/1/comments': comments,
    '/repos/o/r/issues/1/events': events,
    '/repos/o/r/issues/1/labels': null,
    '/repos/o/r/issues/comments/': null,
    '/repos/o/r/collaborators/': { permission },
    '/repos/o/r/issues/1': { number: 1, user: { login: 'author' }, labels: labels.map((name) => ({ name })) },
  });
  const result = await runScenariosGate(gh, 'o/r', {
    event: { issue: { number: 1 }, sender: { login: sender, type: 'User' }, ...event },
    config: configError ? undefined : config,
    configError,
  });
  return { ...result, labelCalls: labelCallsOf(gh), status: postedOf(gh).at(-1) };
}

test('gate: a listed approver\'s approval makes the issue ready', async () => {
  const { labelCalls, status, lines } = await gate({ labels: ['scaffold:needs-gherkin', 'scaffold:gherkin-approved'], event: labelled('labeled', 'scaffold:gherkin-approved') });
  assert.deepEqual(labelCalls, ['-scaffold:needs-gherkin', '+scaffold:ready']);
  assert.match(status, /\| Scenarios \| ✅ approved by `alice` \(1 scenario, `[0-9a-f]{16}`\) \|/);
  assert.match(status, /\| Plan \| ⏳ waiting for `\/plan` \|/);
  assert.match(lines.at(-1), /\| pass \| alice \| `[0-9a-f]{16}` \| 24\.0 \|/);
});

test('gate: an invalid approval is removed and the issue stays needs-gherkin', async () => {
  const cases = [
    [{ events: [applied('author')] }, /the issue author can't approve/],
    [{ events: [applied('mallory')] }, /`mallory` is not a listed approver/],
    [{ comments: [scenariosComment({ updated_at: '2026-01-03T00:00:00Z' })] }, /the scenarios changed after it was approved/],
    [{ comments: [] }, /there are no scenarios to approve/],
    [{ comments: [scenariosComment(), scenariosComment({ id: 6 })] }, /more than one comment is marked as the scenarios/],
    [{ comments: [scenariosComment({ body: `${SCENARIOS_MARKER}\n\`\`\`gherkin\nFeature: f\n\`\`\`` })] }, /the scenarios don't parse: no scenarios/],
    [{ configError: 'bad' }, /`.github\/scaffold-config.yml` is invalid: bad/],
  ];
  for (const [opts, reason] of cases) {
    const { labelCalls, status } = await gate({ labels: ['scaffold:needs-gherkin', 'scaffold:gherkin-approved'], event: labelled('labeled', 'scaffold:gherkin-approved'), ...opts });
    assert.deepEqual(labelCalls, ['-scaffold:gherkin-approved', '+scaffold:needs-gherkin'], String(reason));
    assert.match(status, reason);
  }
});

test('gate: approval before triage has finished is removed', async () => {
  const { labelCalls, status } = await gate({ labels: ['scaffold:needs-info', 'scaffold:gherkin-approved'], event: labelled('labeled', 'scaffold:gherkin-approved') });
  assert.deepEqual(labelCalls, ['-scaffold:gherkin-approved']);
  assert.match(status, /hasn't been triaged as ready yet/);
});

test('gate: editing approved scenarios withdraws approval; a planned issue keeps its slot but loses plan approval', async () => {
  const body = scenariosComment().body;
  const { labelCalls, status } = await gate({
    labels: ['scaffold:gherkin-approved', 'scaffold:planned', 'scaffold:plan-approved'],
    event: { action: 'edited', comment: { body }, changes: { body: { from: body } } },
  });
  assert.deepEqual(labelCalls, ['-scaffold:gherkin-approved', '-scaffold:plan-approved', '+scaffold:needs-gherkin']);
  assert.match(status, /\| Scenarios \| ✏️ scenarios edited: approval withdrawn \|/);
  assert.match(status, /\| Approval \| ⏳ withdrawn: the scenarios changed \|/);
  assert.match(status, /then a member comments `\/plan` again/);
});

test('gate: removing the marker or deleting the comment counts; other comments don\'t', async () => {
  const from = scenariosComment().body;
  const removed = await gate({ labels: ['scaffold:gherkin-approved', 'scaffold:ready'], comments: [], event: { action: 'edited', comment: { body: 'x' }, changes: { body: { from } } } });
  assert.deepEqual(removed.labelCalls, ['-scaffold:gherkin-approved', '-scaffold:ready', '+scaffold:needs-gherkin']);
  assert.match(removed.status, /🗑️ scenarios deleted: approval withdrawn/);
  const other = await gate({ labels: ['scaffold:gherkin-approved'], event: { action: 'edited', comment: { body: '<!-- scaffold:plan -->' } } });
  assert.equal(other.skip, 'comment is not the scenarios');
});

test('gate: under always, removing scaffold:needs-gherkin puts it back', async () => {
  const { labelCalls, status } = await gate({ config: ALWAYS, labels: [], event: labelled('unlabeled', 'scaffold:needs-gherkin') });
  assert.deepEqual(labelCalls, ['+scaffold:needs-gherkin']);
  assert.match(status, /required: `gherkin: always`/);
});

test('gate: under auto, a member can overrule triage either way; others can\'t', async () => {
  const removed = await gate({ labels: [], event: labelled('unlabeled', 'scaffold:needs-gherkin') });
  assert.deepEqual(removed.labelCalls, ['+scaffold:ready']);
  assert.match(removed.status, /➖ not needed \(`scaffold:needs-gherkin` removed by `bob`\)/);
  const notMember = await gate({ labels: [], permission: 'triage', event: labelled('unlabeled', 'scaffold:needs-gherkin') });
  assert.deepEqual(notMember.labelCalls, ['+scaffold:needs-gherkin']);
  const added = await gate({ labels: ['scaffold:ready', 'scaffold:needs-gherkin'], event: labelled('labeled', 'scaffold:needs-gherkin') });
  assert.deepEqual(added.labelCalls, ['-scaffold:ready']);
  assert.match(added.status, /⏳ required \(added by `bob`\)/);
  const addedByOther = await gate({ labels: ['scaffold:ready', 'scaffold:needs-gherkin'], permission: 'read', event: labelled('labeled', 'scaffold:needs-gherkin') });
  assert.deepEqual(addedByOther.labelCalls, ['-scaffold:needs-gherkin']);
});

test('gate: removing an approval by hand sends the issue back to needs-gherkin', async () => {
  const { labelCalls } = await gate({ labels: ['scaffold:ready'], event: labelled('unlabeled', 'scaffold:gherkin-approved') });
  assert.deepEqual(labelCalls, ['-scaffold:ready', '+scaffold:needs-gherkin']);
});

test('gate: does nothing when scenarios are off, or for other labels', async () => {
  assert.match((await gate({ config: OFF, labels: [], event: labelled('labeled', 'scaffold:gherkin-approved') })).skip, /gherkin: off/);
  assert.match((await gate({ labels: [], event: labelled('labeled', 'scaffold:ready') })).skip, /label is not/);
});

test('the manual scenarios template makes the same marked comment, and its Gherkin parses', async () => {
  const { parseGherkin } = await import('../../core/lib/gherkin.mjs');
  const manual = await readFile(new URL('../templates/manual-gherkin.md', import.meta.url), 'utf8');
  assert.ok(manual.startsWith(`${SCENARIOS_MARKER}\n### SCAFFOLD scenarios`));
  const g = parseGherkin(scenariosText(manual));
  assert.deepEqual(g.errors, []);
  assert.deepEqual(g.scenarios[0].tags, ['@scaffold-<issue>-S1']);
});

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
const writerSchema = JSON.parse(await readFile(new URL('../schemas/gherkin.schema.json', import.meta.url), 'utf8'));
// Fake skills: triage, and gherkin-writer replying with each of `drafts` in turn (an Error throws).
const skills = async (name) => (name === 'triage'
  ? { system: 'S', schema, version: '0.3.0', model: 'm' }
  : { system: 'W', schema: writerSchema, version: '0.1.0', model: 'w' });
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

// runTriage with a ready reply. `needed` is the model's scenarios_needed; `drafts` gherkin-writer's replies.
async function triage({ config = AUTO, needed = true, body = 'B', comments = [], drafts = [{ gherkin: GHERKIN, notes: ['Is @ops told?'] }] } = {}) {
  const gh = fakeGh({ '/repos/o/r/issues/1/comments': comments, '/repos/o/r/issues/1/labels': null, '/repos/o/r/issues/comments/': { html_url: 'c' } });
  const prompts = [];
  const reply = { decision: 'ready', type: 'feature', priority: 'medium', summary: 's', questions: [], brief: { goal: 'g', acceptance_criteria: [], affected_areas: [], out_of_scope: [] }, proposed_tickets: [], scenarios_needed: needed };
  const summary = await runTriage(gh, 'o/r', {
    event: { action: 'opened', issue: { number: 1, title: 'T', body, author_association: 'MEMBER', labels: [] } },
    config,
    loadSkill: skills,
    callModel: async ({ model, user }) => {
      if (model === 'm') return structuredClone(reply);
      prompts.push(user);
      const d = drafts.shift();
      if (d instanceof Error) throw d;
      return structuredClone(d);
    },
  });
  const posted = postedOf(gh);
  return { summary, labelCalls: labelCallsOf(gh), posted, status: posted.at(-1), prompts };
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
  assert.match(always.status, /\| Scenarios \| 📝 \[1 drafted\]\(.*\): waiting for a listed approver \|/);
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

test('triage drafts scenarios in the same run when none are given, retrying once if they don\'t parse', async () => {
  const { posted, prompts, summary } = await triage({ drafts: [{ gherkin: 'Scenario: x', notes: [] }, { gherkin: GHERKIN, notes: ['Is @ops told?'] }] });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /<untrusted_triage>\n\{\n  "summary": "s"/);
  assert.match(prompts[1], /Your previous Gherkin didn't parse; fix these:\n- line 1: expected `Feature:` first/);
  const scenarios = posted.find((b) => b.startsWith(SCENARIOS_MARKER));
  assert.match(scenarios, /Source: drafted by gherkin-writer v0\.1\.0 · w · AI-generated: check before approving/);
  assert.match(scenarios, /\*\*Check before approving\*\*\n\n- Is @​ops told\?/);
  assert.match(summary, /\| gherkin-writer \| 0\.1\.0 \| w \| `[0-9a-f]{16}` \| 1 scenarios drafted \|/);
});

test('triage keeps existing scenarios, and a failed draft still leaves the issue needing scenarios', async () => {
  const kept = await triage({ comments: [{ id: 5, user: bot, body: `${SCENARIOS_MARKER}\nold`, html_url: 'old' }] });
  assert.deepEqual(kept.prompts, []);
  assert.match(kept.status, /\| Scenarios \| 📝 \[scenarios\]\(old\): waiting/);
  const failed = await triage({ drafts: [new Error('boom')] });
  assert.ok(failed.labelCalls.at(-1).startsWith('+scaffold:needs-gherkin'));
  assert.ok(!failed.posted.some((b) => b.startsWith(SCENARIOS_MARKER)));
  assert.match(failed.status, /⚠️ drafting scenarios failed: the model call failed/);
  assert.match(failed.status, /a member comments `\/gherkin`/);
});

// /gherkin against a fake issue.
async function gherkinCmd({ labels = ['scaffold:needs-gherkin'], body = '/gherkin cover lockout', association = 'MEMBER', config = AUTO, configError, comments = [], drafts = [{ gherkin: GHERKIN, notes: [] }] } = {}) {
  const { runGherkin } = await import('../gherkin.mjs');
  const gh = fakeGh({
    '/repos/o/r/issues/1/comments': (path) => (path.includes('?page=') ? comments : { html_url: 'c' }),
    '/repos/o/r/issues/1/labels': null,
    '/repos/o/r/issues/comments/': { html_url: 'c' },
    '/repos/o/r/issues/1': { number: 1, title: 'T', body: 'B', user: { login: 'author' }, labels: labels.map((name) => ({ name })) },
  });
  const prompts = [];
  const result = await runGherkin(gh, 'o/r', {
    event: { action: 'created', issue: { number: 1 }, comment: { id: 99, body, author_association: association, user: { type: 'User' } } },
    config: configError ? undefined : config,
    configError,
    loadSkill: skills,
    callModel: async ({ user }) => {
      prompts.push(user);
      const d = drafts.shift();
      if (d instanceof Error) throw d;
      return structuredClone(d);
    },
  });
  const reactions = gh.calls.filter(([, path]) => path.endsWith('/reactions')).map(([, , b]) => b.content);
  const posted = postedOf(gh).filter(Boolean);
  return { ...result, labelCalls: labelCallsOf(gh), posted, status: posted.at(-1), reactions, prompts };
}

test('/gherkin drafts scenarios with the guidance and leaves them for approval', async () => {
  const { labelCalls, posted, status, reactions, prompts } = await gherkinCmd();
  assert.deepEqual(reactions, ['eyes']);
  assert.match(prompts[0], /<untrusted_guidance>\ncover lockout\n<\/untrusted_guidance>/);
  assert.ok(posted.some((b) => b?.startsWith(SCENARIOS_MARKER)));
  assert.deepEqual(labelCalls, ['+scaffold:needs-gherkin']);
  assert.match(status, /\| Scenarios \| 📝 \[1 drafted\]\(c\): waiting for a listed approver \|/);
});

test('/gherkin redrafts from the current scenarios and withdraws approvals', async () => {
  const current = { id: 5, user: bot, body: renderScenarios(GHERKIN, { issue: 1, source: 't' }).body, html_url: 'u' };
  const { labelCalls, status, prompts } = await gherkinCmd({ labels: ['scaffold:gherkin-approved', 'scaffold:planned', 'scaffold:plan-approved'], comments: [current] });
  assert.match(prompts[0], /<untrusted_previous_scenarios>\nFeature: Login\n  @scaffold-1-S1/);
  assert.deepEqual(labelCalls, ['-scaffold:gherkin-approved', '-scaffold:plan-approved', '+scaffold:needs-gherkin']);
  assert.match(status, /1 redrafted/);
  assert.match(status, /\| Approval \| ⏳ withdrawn: the scenarios changed \|/);
  assert.match(status, /then a member comments `\/plan` again/);
});

test('/gherkin is refused for non-members, before triage, when scenarios are off, or on invalid config', async () => {
  for (const [opts, skip] of [
    [{ association: 'NONE' }, /members only/],
    [{ labels: ['scaffold:needs-info'] }, /not triaged yet/],
    [{ config: OFF }, /gherkin: off/],
    [{ configError: 'bad' }, /invalid config: bad/],
  ]) {
    const r = await gherkinCmd(opts);
    assert.match(r.skip, skip);
    assert.deepEqual(r.reactions, ['confused']);
    assert.deepEqual(r.prompts, []);
    assert.deepEqual(r.labelCalls, []);
  }
});

test('a failed /gherkin keeps the current scenarios and approval', async () => {
  const { labelCalls, posted, status } = await gherkinCmd({ labels: ['scaffold:gherkin-approved', 'scaffold:ready'], drafts: [new Error('boom')] });
  assert.deepEqual(labelCalls, []);
  assert.ok(!posted.some((b) => b.startsWith(SCENARIOS_MARKER)));
  assert.match(status, /⚠️ `\/gherkin` failed: the model call failed/);
});

test('gherkin-writer loads from the intake package with the standard tier', async () => {
  const { loadSkill } = await import('../../core/lib/skills.mjs');
  const { fileURLToPath } = await import('node:url');
  const skill = await loadSkill(fileURLToPath(new URL('..', import.meta.url)), 'gherkin-writer');
  const models = await readFile(new URL('../../core/config/models.yml', import.meta.url), 'utf8');
  assert.equal(skill.model, models.match(/^standard:\s*(\S+)/m)[1]);
  assert.deepEqual(skill.schema, writerSchema);
  assert.ok(skill.system.startsWith('# Gherkin writer'));
});

test('gate: an untriaged issue (no lifecycle label) can\'t have its scenarios approved, or /gherkin run', async () => {
  const { labelCalls, status } = await gate({ labels: ['scaffold:gherkin-approved'], event: labelled('labeled', 'scaffold:gherkin-approved') });
  assert.deepEqual(labelCalls, ['-scaffold:gherkin-approved']);
  assert.match(status, /hasn't been triaged as ready yet/);
  const cmd = await gherkinCmd({ labels: [] });
  assert.match(cmd.skip, /not triaged yet/);
  assert.deepEqual(cmd.prompts, []);
});

test('gate: editing a member\'s hand-written scenarios comment withdraws approval too', async () => {
  const body = scenariosComment().body;
  const member = { ...scenariosComment(), user: { login: 'dave' }, author_association: 'MEMBER', updated_at: '2026-01-03T00:00:00Z' };
  const { labelCalls, status } = await gate({
    labels: ['scaffold:gherkin-approved', 'scaffold:ready'], comments: [member],
    event: { action: 'edited', comment: { body }, changes: { body: { from: body } } },
  });
  assert.deepEqual(labelCalls, ['-scaffold:gherkin-approved', '-scaffold:ready', '+scaffold:needs-gherkin']);
  assert.match(status, /✏️ scenarios edited: approval withdrawn/);
});

test('gate: a rejected approval on a ready issue leaves scenarios required and withdraws plan approval', async () => {
  const ready = await gate({ labels: ['scaffold:ready', 'scaffold:gherkin-approved'], events: [applied('author')], event: labelled('labeled', 'scaffold:gherkin-approved') });
  assert.deepEqual(ready.labelCalls, ['-scaffold:gherkin-approved', '-scaffold:ready', '+scaffold:needs-gherkin']);
  const planned = await gate({ labels: ['scaffold:planned', 'scaffold:plan-approved', 'scaffold:gherkin-approved'], events: [applied('author')], event: labelled('labeled', 'scaffold:gherkin-approved') });
  assert.deepEqual(planned.labelCalls, ['-scaffold:gherkin-approved', '-scaffold:plan-approved', '+scaffold:needs-gherkin']);
  assert.match(planned.status, /\| Approval \| ⏳ withdrawn: the scenarios approval failed \|/);
});

test('gate: with an invalid config, scaffold:needs-gherkin overrides fail closed', async () => {
  const removed = await gate({ configError: 'bad', labels: [], event: labelled('unlabeled', 'scaffold:needs-gherkin') });
  assert.deepEqual(removed.labelCalls, ['+scaffold:needs-gherkin']);
  assert.match(removed.status, /⛔ `.github\/scaffold-config.yml` is invalid: bad/);
  const added = await gate({ configError: 'bad', labels: ['scaffold:ready', 'scaffold:needs-gherkin'], event: labelled('labeled', 'scaffold:needs-gherkin') });
  assert.deepEqual(added.labelCalls, []);
});

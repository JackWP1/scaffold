import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { unzip, cucumberResults, bddReport } from '../checks/bdd.mjs';
import { scenariosCheck, planMapping } from '../checks/scenarios.mjs';
import { configFrom } from '../lib/config.mjs';
import { tagScenarios, SCENARIOS_MARKER } from '../lib/gherkin.mjs';
import { fakeGh } from './fake-github.mjs';

// A minimal zip writer for fixtures: one deflated entry per file.
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const scenario = (tags, statuses) => ({ type: 'scenario', tags: tags.map((name) => ({ name })), steps: statuses.map((status) => ({ result: { status } })) });

test('zip: reads deflated entries; rejects non-zip data', () => {
  assert.equal(unzip(zip({ 'a/report.json': '[1]' }))['a/report.json'].toString(), '[1]');
  assert.throws(() => unzip(Buffer.from('nope')), /not a zip/);
});

test('Cucumber results: a tag passes only if every scenario carrying it passed every step', () => {
  const r = cucumberResults([{ tags: [{ name: '@login' }], elements: [
    scenario(['@scaffold-7-S1'], ['passed', 'passed']),
    scenario(['@scaffold-7-S2'], ['passed', 'failed']),
    scenario(['@scaffold-7-S3'], ['passed']), scenario(['@scaffold-7-S3'], ['skipped']),
    scenario(['@scaffold-7-S4'], []),
    { type: 'background', steps: [{ result: { status: 'failed' } }] },
  ] }]);
  assert.deepEqual(Object.fromEntries(r), { '@login': 'failed', '@scaffold-7-S1': 'passed', '@scaffold-7-S2': 'failed', '@scaffold-7-S3': 'failed', '@scaffold-7-S4': 'failed' });
  assert.throws(() => cucumberResults({}), /not a Cucumber JSON report/);
});

test('BDD report: waits for the head SHA\'s run, then reads the artifact; fails closed otherwise', async () => {
  const bdd = { workflow: 'ci.yml', artifact: 'scaffold-bdd-report' };
  const json = JSON.stringify([{ elements: [scenario(['@scaffold-7-S1'], ['passed'])] }]);
  let polls = 0;
  const gh = (runs, artifacts = [{ id: 3, name: 'scaffold-bdd-report', size_in_bytes: 10 }], body = zip({ 'cucumber.json': json })) => fakeGh({
    '/repos/o/r/actions/workflows/ci.yml/runs': () => ({ workflow_runs: runs(polls++) }),
    '/repos/o/r/actions/runs/9/artifacts': { artifacts },
    '/repos/o/r/actions/artifacts/3/zip': body,
  });
  const done = { id: 9, head_sha: 'abc', status: 'completed', created_at: '2026-01-01T00:00:00Z' };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const r = await bddReport(gh((n) => (n < 2 ? [{ ...done, status: 'in_progress' }] : [done])), 'o/r', { bdd, sha: 'abc', sleep, pollMs: 10, waitMs: 100 });
  assert.equal(r.results.get('@scaffold-7-S1'), 'passed');
  assert.deepEqual(sleeps, [10, 10]);
  polls = 0;
  assert.match((await bddReport(gh(() => []), 'o/r', { bdd, sha: 'abc', sleep, pollMs: 10, waitMs: 20 })).error, /no `ci.yml` run for abc yet/);
  assert.match((await bddReport(gh(() => [{ ...done, head_sha: 'other' }]), 'o/r', { bdd, sha: 'abc', sleep, pollMs: 10, waitMs: 0 })).error, /no `ci.yml` run/, 'a run for another SHA is stale');
  assert.match((await bddReport(gh(() => [done], []), 'o/r', { bdd, sha: 'abc', sleep })).error, /no `scaffold-bdd-report` artifact/);
  assert.match((await bddReport(gh(() => [done], undefined, zip({ 'x.txt': 'hi' })), 'o/r', { bdd, sha: 'abc', sleep })).error, /no .json report/);
  assert.match((await bddReport(gh(() => [done], undefined, zip({ 'r.json': '{oops' })), 'o/r', { bdd, sha: 'abc', sleep })).error, /can't be read/);
});

// The scenarios check against issue 7 and PR 4.
const AUTO = configFrom('approvers: [alice]\ngherkin: auto\nbdd:\n  workflow: ci.yml\n  artifact: r');
const GHERKIN = 'Feature: Login\n  Scenario: ok\n    When ada signs in\n    Then she is in\n  Scenario: wrong\n    When ada mistypes\n    Then she sees an error';
const TAGGED = tagScenarios(GHERKIN, 7).text;
const [S1, S2] = TAGGED.split(/\n(?=  @scaffold-7-S2)/);
const bot = { login: 'github-actions[bot]' };
const plan = (split, maps) => `<!-- scaffold:plan -->\nplan\n<!-- scaffold:plan-data ${Buffer.from(JSON.stringify({ split, subtasks: maps.map((scenarios, i) => ({ id: String(i + 1), scenarios })) })).toString('base64')} -->`;

function check({ config = AUTO, body = 'Fixes #7', labels = ['scaffold:ready', 'scaffold:gherkin-approved'], approvedBy = 'alice', planBody = plan('none', [['S1', 'S2']]), head = TAGGED, base = 'Feature: Login', results = { '@scaffold-7-S1': 'passed', '@scaffold-7-S2': 'passed' }, reportError } = {}) {
  const content = (text) => (text === null ? new Error('GET: 404 Not Found') : { content: Buffer.from(text).toString('base64') });
  const gh = fakeGh({
    '/repos/o/r/issues/7/comments': [{ user: bot, body: `${SCENARIOS_MARKER}\n\`\`\`gherkin\n${TAGGED}\n\`\`\``, updated_at: '2026-01-01T00:00:00Z' }, ...(planBody ? [{ user: bot, body: planBody }] : [])],
    '/repos/o/r/issues/7/events': [{ id: 1, event: 'labeled', label: { name: 'scaffold:gherkin-approved' }, actor: { login: approvedBy, type: 'User' }, created_at: '2026-01-02T00:00:00Z' }],
    '/repos/o/r/issues/7': { number: 7, user: { login: 'carol' }, labels: labels.map((name) => ({ name })) },
    '/repos/o/r/git/trees/head': { tree: [{ type: 'blob', path: 'features/login.feature' }, { type: 'blob', path: 'src/a.js' }] },
    '/repos/o/r/contents/features/login.feature': (path) => content(path.includes('ref=head') ? head : base),
    '/repos/o/r/pulls/4/files': [{ filename: 'features/login.feature', status: 'modified' }],
  });
  const pr = { number: 4, body, base: { sha: 'base' }, head: { sha: 'head' } };
  const report = async () => (reportError ? { error: reportError } : { results: new Map(Object.entries(results)) });
  return scenariosCheck({ gh, repo: 'o/r', pr, config, report });
}

test('scenarios check: off, not linked, not required', async () => {
  assert.match((await check({ config: configFrom('') })).outcome, /scenarios off/);
  assert.match((await check({ body: 'no link' })).outcome, /no linked issue: scenarios not required/);
  const always = configFrom('approvers: [alice]\ngherkin: always\nbdd:\n  workflow: ci.yml\n  artifact: r');
  assert.equal((await check({ config: always, body: 'no link' })).ok, false);
  assert.match((await check({ labels: ['scaffold:ready'] })).outcome, /#7 doesn't need scenarios/);
});

test('scenarios check: a one-PR plan needs every approved scenario, matching and passing', async () => {
  const ok = await check();
  assert.equal(ok.ok, true, ok.outcome);
  assert.match(ok.outcome, /2 scenarios of #7 \(S1, S2\) match the approved text and passed/);
  assert.match((await check({ approvedBy: 'carol' })).outcome, /scenarios aren't approved: the issue author can't approve/);
  const drift = await check({ head: TAGGED.replace('she is in', 'she is out') });
  assert.equal(drift.ok, false);
  assert.ok(drift.details.includes('- `@scaffold-7-S1` doesn\'t match the approved text'));
  assert.ok((await check({ head: S1 })).details.includes('- `@scaffold-7-S2` is missing (the top of the stack needs every approved scenario)'));
  assert.ok((await check({ head: `${TAGGED}\n  @scaffold-7-S9\n  Scenario: extra\n    Given x` })).details.includes('- `@scaffold-7-S9` isn\'t an approved scenario of #7'));
  const failed = await check({ results: { '@scaffold-7-S1': 'passed', '@scaffold-7-S2': 'failed' } });
  assert.match(failed.outcome, /1 scenario didn't run and pass on head/);
  assert.deepEqual(failed.details, ['- `@scaffold-7-S2`: failed']);
  assert.match((await check({ reportError: 'no `ci.yml` run for head yet' })).outcome, /no `ci.yml` run/);
});

test('scenarios check: in a stack, the scenarios a PR adds pick its sub-task; the top needs them all', async () => {
  const stack = plan('stack', [['S1'], [], ['S2']]);
  const bottom = await check({ planBody: stack, head: S1, results: { '@scaffold-7-S1': 'passed' } });
  assert.equal(bottom.ok, true, bottom.details.join());
  assert.match(bottom.outcome, /\(S1\) .* \(this PR's part of the stack\)/);
  const middle = await check({ planBody: stack, head: S1, base: S1, results: {} });
  assert.equal(middle.ok, true, 'adds none: the middle PR, nothing to run');
  const topOk = await check({ planBody: stack, head: TAGGED, base: S1 });
  assert.equal(topOk.ok, true, topOk.details.join());
  assert.match(topOk.outcome, /\(S1, S2\) match/);
  const wrong = await check({ planBody: plan('stack', [['S1'], ['S2']]), head: TAGGED, base: 'Feature: Login' });
  assert.match(wrong.details[0], /the scenarios this PR adds \(S1,S2\) aren't one PR's list in the plan: 1: S1; 2: S2/);
});

test('plan mapping reads the plan comment\'s data, and is null without it', () => {
  assert.deepEqual(planMapping(plan('stack', [['S2', 'S1']])), { split: 'stack', subtasks: [{ id: '1', scenarios: ['S1', 'S2'] }] });
  assert.equal(planMapping('<!-- scaffold:plan -->\nwritten by hand'), null);
});

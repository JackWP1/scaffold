import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseYaml, configFrom, DEFAULTS, ConfigError, stageOn, PACKAGES, RELEASED } from '../lib/config.mjs';
import { validate } from '../lib/validate.mjs';

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

test('an invalid scaffold-config.yml is rejected, not replaced by defaults', () => {
  const cases = {
    'max_in_flight: foo': /max_in_flight: expected integer/,
    'max_in_flight: 0': /max_in_flight: less than 1/,
    'max_in_flight: 101': /max_in_flight: more than 100/,
    'max_stack_prs: 11': /max_stack_prs: more than 10/,
    'max_stack_prs: 0': /max_stack_prs: less than 1/,
    'warn_open_prs_per_developer: 20': /warn_open_prs_per_developer: more than 10/,
    'max_rework_rounds: 0': /max_rework_rounds: less than 1/,
    'stages: on': /stages: expected object/,
    'stages:\n  plan: yes': /stages.plan: expected true or false/,
    'stages:\n  deploy: true': /stages.deploy: not allowed/,
    'stages:\n  review: true': /stages.review: not released yet/,
    'approvers: alice': /approvers: expected array/,
    'approvers:\n  - "not a login"': /approvers\[0\]: not a GitHub login/,
    'flow_lead: [a, b]': /flow_lead: expected string/,
    'pr_size: big': /pr_size: expected object/,
    'stages: null': /stages: expected object/,
    'approvers: null': /approvers: expected array/,
    'pr_size: null': /pr_size: expected object/,
    'pr_size:\n  soft: null': /pr_size.soft: expected object/,
    'pr_size:\n  soft:\n    files: -1': /soft.files: less than 1/,
    'pr_size:\n  soft:\n    lines: 9000': /soft.lines: more than pr_size.hard.lines/,
    'pr_size:\n  exempt:\n    - ""': /exempt\[0\]: empty/,
    'max_inflight: 3': /max_inflight: not allowed/,
    'gherkin: sometimes': /gherkin: not one of off, auto, always/,
    'gherkin: auto': /bdd: required unless gherkin is off/,
    'gherkin: always\nbdd: null': /bdd: expected object/,
    'gherkin: auto\nbdd:\n  workflow: ci.yml': /bdd.artifact: required/,
    'gherkin: auto\nbdd:\n  workflow: ci\n  artifact: r': /bdd.workflow: not a workflow file name/,
    'gherkin: auto\nbdd:\n  workflow: ci.yml\n  artifact: a/b': /bdd.artifact: not an artifact name/,
    ': nope': /can't parse line 1/,
    '- just a list': /expected a map/,
  };
  for (const [yaml, error] of Object.entries(cases)) {
    assert.throws(() => configFrom(yaml), (err) => err instanceof ConfigError && error.test(err.message), yaml);
  }
});

test('gherkin defaults to off; on needs bdd', () => {
  assert.equal(configFrom('').gherkin, 'off');
  const config = configFrom('gherkin: always\nbdd:\n  workflow: ci.yml\n  artifact: scaffold-bdd-report');
  assert.equal(config.gherkin, 'always');
  assert.deepEqual(config.bdd, { workflow: 'ci.yml', artifact: 'scaffold-bdd-report' });
});

test('flow_lead: null is allowed (no flow lead)', () => {
  assert.equal(configFrom('flow_lead: null').flow_lead, null);
});

test('a missing scaffold-config.yml lists no approvers and turns every package off', () => {
  const config = configFrom('');
  assert.deepEqual(config.approvers, []);
  assert.equal(config.max_in_flight, 20);
  assert.equal(config.max_stack_prs, 5);
  assert.equal(config.warn_open_prs_per_developer, 2);
  assert.equal(config.max_rework_rounds, 6);
  for (const p of PACKAGES) assert.equal(stageOn(config, p), false, p);
});

test('a package not listed in stages is off; listed false is off', () => {
  const config = configFrom('stages:\n  intake: true\n  plan: false\n  implement: false');
  assert.equal(stageOn(config, 'intake'), true);
  assert.equal(stageOn(config, 'plan'), false);
  assert.equal(stageOn(config, 'review'), false);
});

test('the scaffold-config.yml template parses with the released packages on', async () => {
  const config = configFrom(await readFile(new URL('../../../templates/caller/.github/scaffold-config.yml', import.meta.url), 'utf8'));
  assert.deepEqual(config.pr_size, DEFAULTS.pr_size);
  for (const k of ['max_in_flight', 'max_stack_prs', 'warn_open_prs_per_developer', 'max_rework_rounds']) assert.equal(config[k], DEFAULTS[k], k);
  assert.deepEqual(PACKAGES.filter((p) => stageOn(config, p)), RELEASED);
  assert.equal(config.gherkin, 'off');
});

test('validator handles booleans and maximums', () => {
  assert.deepEqual(validate({ type: 'boolean' }, true), []);
  assert.deepEqual(validate({ type: 'boolean' }, 'true'), ['$: expected true or false']);
  assert.deepEqual(validate({ type: 'integer', maximum: 3 }, 4), ['$: more than 3']);
});

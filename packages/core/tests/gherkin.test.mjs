import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGherkin, scenarioHash, scenarioTag, tagScenarios, scenariosText, SCENARIOS_MARKER, MAX_SCENARIOS } from '../lib/gherkin.mjs';

const FEATURE = `# login
@auth
Feature: Login
  Users sign in with a password.

  Background:
    Given a user "ada" exists

  @happy
  Scenario: Correct password
    When ada signs in with   "secret"
    Then she sees her dashboard

  Scenario Outline: Wrong password
    When ada signs in with "<password>"
    Then she sees "<message>"
    And the attempt is logged:
      """
      failed login for ada
      """

    Examples:
      | password | message        |
      | wrong    | Wrong password |
`;

test('parses a feature with background, tags, outlines, doc strings and examples', () => {
  const g = parseGherkin(FEATURE);
  assert.deepEqual(g.errors, []);
  assert.equal(g.feature, 'Login');
  assert.deepEqual(g.background, ['Given a user "ada" exists']);
  assert.equal(g.scenarios.length, 2);
  assert.deepEqual(g.scenarios[0], { name: 'Correct password', line: 9, tags: ['@happy'], steps: ['When ada signs in with "secret"', 'Then she sees her dashboard'], examples: [] });
  assert.deepEqual(g.scenarios[1].steps.slice(2), ['And the attempt is logged:', '  failed login for ada']);
  assert.deepEqual(g.scenarios[1].examples, ['password | message', 'wrong | Wrong password']);
});

test('the hash ignores whitespace, names and tags but not steps or examples', () => {
  const [a] = parseGherkin(FEATURE).scenarios;
  const [b] = parseGherkin(FEATURE.replace('Scenario: Correct password', 'Scenario:   Right password').replace('@happy', '@x').replace('Then she', 'Then   she')).scenarios;
  const [c] = parseGherkin(FEATURE.replace('dashboard', 'inbox')).scenarios;
  assert.equal(scenarioHash(a), scenarioHash(b));
  assert.notEqual(scenarioHash(a), scenarioHash(c));
  const outline = (t) => scenarioHash(parseGherkin(t).scenarios[1]);
  assert.notEqual(outline(FEATURE), outline(FEATURE.replace('| wrong    |', '| bad |')));
});

test('rejects text that is not valid scenarios', () => {
  const cases = {
    '': /no `Feature:`/,
    'Scenario: x\n  Given y': /expected `Feature:` first/,
    'Feature: f': /no scenarios/,
    'Feature: f\nScenario: s': /scenario 1 \(s\) has no steps/,
    'Feature: f\nScenario:\n  Given x': /scenario 1 has no name/,
    'Feature: f\nScenario Outline: s\n  Given <x>': /outline without an Examples table/,
    'Feature: f\nScenario: s\n  Given x\nExamples:\n  | a |': /Examples only belong to a Scenario Outline/,
    'Feature: f\nGiven x': /step outside a scenario/,
    'Feature: f\nScenario: s\n  Given x\n  """\n  open': /doc string is not closed/,
    'Feature: f\nScenario: s\n  Given x\n  Whenever y': /can't parse `Whenever y`/,
    'Feature: f\nFeature: g': /only one Feature/,
    'Feature: f\nScenario: s\n  Given x\nBackground:\n  Given y': /Background must come once/,
    'Feature: f\n@ bad\nScenario: s\n  Given x': /tags must be/,
    [`Feature: f\n${'Scenario: s\n  Given x\n'.repeat(MAX_SCENARIOS + 1)}`]: /more than 20 scenarios/,
  };
  for (const [text, error] of Object.entries(cases)) {
    const { errors } = parseGherkin(text);
    assert.ok(errors.some((e) => error.test(e)), `${JSON.stringify(text)}: ${errors.join('; ')}`);
  }
});

test('scenario tags tie an issue scenario to its feature file', () => {
  assert.equal(scenarioTag(42, 3), '@scaffold-42-S3');
});

test('scenarios are numbered by tag, replacing old SCAFFOLD tags but not the author\'s', () => {
  const { text, scenarios, errors } = tagScenarios(FEATURE.replace('@happy', '@happy @scaffold-7-S9'), 42);
  assert.deepEqual(errors, []);
  assert.deepEqual(scenarios.map((s) => s.tags), [['@happy', '@scaffold-42-S1'], ['@scaffold-42-S2']]);
  assert.match(text, /  @happy\n  @scaffold-42-S1\n  Scenario: Correct password/);
  assert.doesNotMatch(text, /S9/);
  assert.deepEqual(scenarios.map(scenarioHash), parseGherkin(FEATURE).scenarios.map(scenarioHash));
  assert.equal(tagScenarios(text, 42).text, text);
  assert.deepEqual(tagScenarios('Feature: f', 1), { text: null, scenarios: [], errors: ['no scenarios'] });
});

test('the scenarios comment holds its Gherkin in the first gherkin fence', () => {
  const body = `${SCENARIOS_MARKER}\n### Scenarios\n\n\`\`\`\`gherkin\nFeature: f\n\`\`\`\nScenario: s\n\`\`\`\`\n\nmore`;
  assert.equal(scenariosText(body), 'Feature: f\n```\nScenario: s');
  assert.equal(scenariosText('no marker\n```gherkin\nx\n```'), null);
  assert.equal(scenariosText(SCENARIOS_MARKER), null);
});

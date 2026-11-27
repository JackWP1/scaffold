import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchesAny, prSize, linkedIssues } from '../lib/pr.mjs';
import { protectedPaths, hardSize, pinOnly } from '../checks/baseline.mjs';
import { runCheck } from '../checks/run.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { fakeGh } from './fake-github.mjs';

const file = (filename, additions = 1, deletions = 0, extra = {}) => ({ filename, status: 'modified', additions, deletions, ...extra });

test('globs: ** spans directories, * one segment, a bare name matches in any directory', () => {
  assert.ok(globToRegExp('dist/**').test('dist/a/b.js'));
  assert.ok(!globToRegExp('dist/**').test('src/dist/a.js'));
  assert.ok(globToRegExp('package-lock.json').test('app/package-lock.json'));
  assert.ok(globToRegExp('*.lock').test('yarn.lock') && !globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(globToRegExp('docs/spec/**').test('docs/spec/x.md') && globToRegExp('.github/**').test('.github/workflows/ci.yml'));
  assert.ok(matchesAny('a/CODEOWNERS', ['CODEOWNERS']) && !matchesAny('a.b', ['a?c']));
});

test('PR size excludes exempt files; linked issues come from closing keywords', () => {
  const files = [file('src/a.js', 10, 5), file('package-lock.json', 900, 900), file('dist/x.js', 50)];
  assert.deepEqual(prSize(files, DEFAULTS.pr_size.exempt), { files: 1, lines: 15, exempt: 2 });
  assert.deepEqual(linkedIssues('Fixes #12. Also closes: #3, see #9; resolved #12'), [12, 3]);
  assert.deepEqual(linkedIssues(null), []);
});

test('protected paths: .github, CODEOWNERS, PRECEDENTS.md, docs/spec; renames count both paths', () => {
  assert.equal(protectedPaths([file('src/a.js'), file('docs/readme.md')]).ok, true);
  const r = protectedPaths([file('.github/workflows/ci.yml'), file('docs/CODEOWNERS'), file('PRECEDENTS.md'), file('docs/spec/login.md'), file('src/x.md', 1, 0, { previous_filename: 'docs/spec/x.md', status: 'renamed' })]);
  assert.equal(r.ok, false);
  assert.match(r.outcome, /5 files/);
  assert.ok(r.details.includes('- `docs/spec/x.md`'));
});

test('protected paths: scaffold-config.yml has its own check; other protected files in the same PR still fail', () => {
  assert.equal(protectedPaths([file('.github/scaffold-config.yml')]).ok, true);
  assert.equal(protectedPaths([file('.github/scaffold-config.yml'), file('.github/CODEOWNERS')]).ok, false);
});

const bump = [
  '@@ -31,3 +31,3 @@',
  '-    uses: JackWP1/scaffold/.github/workflows/triage.yml@aaaa # v0.5.0',
  '+    uses: JackWP1/scaffold/.github/workflows/triage.yml@bbbb # v0.6.0',
  '-    uses: ukncsc/scaffold/.github/workflows/plan.yml@aaaa',
  '+    uses: ukncsc/scaffold/.github/workflows/plan.yml@bbbb # v0.6.0',
].join('\n');

test('protected paths: a caller change that only moves SCAFFOLD pins passes; anything else fails', () => {
  const caller = (patch, status = 'modified') => file('.github/workflows/scaffold.yml', 2, 2, { patch, status });
  assert.equal(pinOnly(caller(bump)), true);
  assert.equal(protectedPaths([caller(bump)]).ok, true);
  for (const patch of [
    `${bump}\n+    permissions: write-all`,
    bump.replace('plan.yml@bbbb', 'evil.yml@bbbb'),
    bump.replace('+    uses: JackWP1/scaffold', '+    uses: attacker/scaffold'),
    undefined,
  ]) assert.equal(protectedPaths([caller(patch)]).ok, false, patch);
  assert.equal(pinOnly(caller(bump, 'renamed')), false);
  const r = protectedPaths([caller('+ x')]);
  assert.match(r.details.at(-1), /may only change its SCAFFOLD pins/);
});

test('hard size: over either hard limit fails and can\'t be lifted; exempt files don\'t count', () => {
  const limits = DEFAULTS.pr_size;
  assert.equal(hardSize([file('a.js', 4000, 999)], limits).ok, true);
  const lines = hardSize([file('a.js', 4000, 1001)], limits);
  assert.equal(lines.ok, false);
  assert.match(lines.outcome, /1 files \/ 5001 lines is over the hard limit \(30 files \/ 5000 lines\)/);
  assert.match(lines.details[0], /can't be lifted/);
  assert.equal(hardSize(Array.from({ length: 31 }, (_, i) => file(`f${i}.js`)), limits).ok, false);
  assert.match(hardSize([file('a.js'), file('yarn.lock', 9000)], limits).outcome, /1 exempt file not counted/);
  assert.equal(hardSize([file('a.js')], limits, { truncated: true }).ok, false);
});

test('runCheck reads limits from the base commit and fails closed on an invalid config', async () => {
  const pr = { number: 4, base: { sha: 'base' }, head: { sha: 'head' } };
  const gh = (config) => fakeGh({
    '/repos/o/r/pulls/4/files': [file('a.js', 600, 0)],
    '/repos/o/r/contents/.github/scaffold-config.yml': (path) => {
      assert.match(path, /ref=base/);
      return { content: Buffer.from(config).toString('base64') };
    },
  });
  const tight = await runCheck(gh('pr_size:\n  soft:\n    files: 1\n    lines: 100\n  hard:\n    files: 1\n    lines: 500'), 'o/r', { check: 'scaffold-hard-size', pr });
  assert.equal(tight.ok, false);
  assert.equal(tight.lines[0], '### scaffold-hard-size');
  const invalid = await runCheck(gh('max_in_flight: nope'), 'o/r', { check: 'scaffold-hard-size', pr });
  assert.equal(invalid.ok, false);
  assert.match(invalid.outcome, /on the base branch is invalid/);
  assert.equal((await runCheck(gh(''), 'o/r', { check: 'scaffold-protected-paths', pr })).ok, true);
  assert.match((await runCheck(gh(''), 'o/r', { check: 'nope', pr })).outcome, /unknown check/);
});

import { testFindings, featureFindings } from '../checks/integrity.mjs';
import { tagScenarios, scenarioHash, parseGherkin } from '../lib/gherkin.mjs';
import { configFrom } from '../lib/config.mjs';

const patch = (removed = [], added = []) => ['@@ -1 +1 @@', ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n');

test('test integrity: removed, skipped or focused tests and removed assertions are flagged', () => {
  const f = (name, p, extra = {}) => file(name, 1, 1, { patch: p, ...extra });
  const findings = testFindings([
    f('src/a.test.js', patch(["it('logs in', () => {", '  expect(x).toBe(1);'], ["it.skip('logs in', () => {"])),
    f('tests/test_api.py', patch(['def test_get():', '    assert r.ok'], [])),
    f('pkg/b_test.go', patch([], ['\tt.Skip("flaky")'])),
    f('src/c.spec.ts', patch([], ["fit('only this', () => {})"])),
    file('test/old.test.js', 0, 9, { status: 'removed' }),
    file('src/moved.js', 0, 0, { status: 'renamed', previous_filename: 'test/moved.test.js', patch: '' }),
    file('src/big.test.js', 0, 900),
    f('src/app.js', patch(['expect(x)'], [])),
  ]);
  assert.deepEqual(findings, [
    '`src/a.test.js`: 1 test skipped, focused or left to do',
    '`src/a.test.js`: 1 fewer assertion',
    '`tests/test_api.py`: 1 fewer test',
    '`tests/test_api.py`: 1 fewer assertion',
    '`pkg/b_test.go`: 1 test skipped, focused or left to do',
    '`src/c.spec.ts`: 1 test skipped, focused or left to do',
    '`test/old.test.js`: test file deleted',
    '`test/moved.test.js`: moved out of the test paths to `src/moved.js`',
    '`src/big.test.js`: diff too large to check',
  ]);
  assert.deepEqual(testFindings([file('src/a.test.js', 2, 1, { patch: patch(["it('a', () => {"], ["it('a', () => {", "it('b', () => {"]) })]), []);
});

const FEATURE = 'Feature: Login\n  @scaffold-7-S1\n  Scenario: ok\n    When ada signs in\n    Then she is in\n  Scenario: legacy\n    Given old\n    Then old';

test('test integrity: changed or removed scenarios in existing feature files need the approved scenarios', async () => {
  const run = (head, approved = new Map(), status = 'modified') => featureFindings([file('features/login.feature', 1, 1, { status })], {
    read: async (path, ref) => (ref === 'base' ? FEATURE : head), baseRef: 'base', headRef: 'head', approved,
  });
  assert.deepEqual(await run(FEATURE.replace('Then old', '  Then   old')), [], 'whitespace only');
  assert.deepEqual(await run(FEATURE.replace('Then she is in', 'Then she is out')), ['`features/login.feature`: scenario "ok" changed and not in the approved scenarios']);
  const changed = FEATURE.replace('Then she is in', 'Then she is out');
  const hash = scenarioHash(parseGherkin(changed).scenarios[0]);
  assert.deepEqual(await run(changed, new Map([['@scaffold-7-S1', hash]])), [], 'the approved change');
  assert.deepEqual(await run(FEATURE.split('  Scenario: legacy')[0]), ['`features/login.feature`: scenario "legacy" removed (no SCAFFOLD tag) and not in the approved scenarios']);
  assert.equal((await run(null, new Map(), 'removed')).length, 2);
  assert.deepEqual(await featureFindings([file('features/new.feature', 9, 0, { status: 'added' })], { read: async () => { throw new Error('not read'); } }), []);
});

test('test integrity check: findings fail until a listed approver applies the label; a later push removes it', async () => {
  const pr = { number: 4, body: 'Fixes #7', user: { login: 'copilot-swe-agent' }, base: { sha: 'base' }, head: { sha: 'head' }, updated_at: '2026-11-20T12:00:00Z' };
  const applied = (login, at) => ({ id: 1, event: 'labeled', label: { name: 'scaffold:test-change-approved' }, actor: { login, type: 'User' }, created_at: at });
  const run = ({ labels = [], events = [], action = 'labeled' } = {}) => {
    const gh = fakeGh({
      '/repos/o/r/pulls/4/files': [file('src/a.test.js', 0, 1, { patch: patch(['  expect(x).toBe(1);']) })],
      '/repos/o/r/contents/.github/scaffold-config.yml': { content: Buffer.from('approvers: [alice]').toString('base64') },
      '/repos/o/r/issues/4/events': events,
      '/repos/o/r/issues/4/labels': null,
      '/repos/o/r/issues/4': { number: 4, labels: labels.map((name) => ({ name })) },
    });
    return runCheck(gh, 'o/r', { check: 'scaffold-test-integrity', pr, event: { action } }).then((r) => ({ ...r, gh }));
  };
  const none = await run();
  assert.equal(none.ok, false);
  assert.match(none.outcome, /1 test integrity finding/);
  assert.ok(none.lines.some((l) => l.includes('applies `scaffold:test-change-approved`')));
  assert.ok(none.lines.includes('- `src/a.test.js`: 1 fewer assertion'));
  const ok = await run({ labels: ['scaffold:test-change-approved'], events: [applied('alice', '2026-11-20T13:00:00Z')] });
  assert.equal(ok.ok, true);
  assert.match(ok.outcome, /1 finding approved by `alice`/);
  const author = await run({ labels: ['scaffold:test-change-approved'], events: [applied('mallory', '2026-11-20T13:00:00Z')] });
  assert.match(author.outcome, /not valid: `mallory` is not a listed approver/);
  const stale = await run({ labels: ['scaffold:test-change-approved'], events: [applied('alice', '2026-11-20T11:00:00Z')], action: 'synchronize' });
  assert.equal(stale.ok, false);
  assert.match(stale.outcome, /new commits since .* label removed/);
  assert.ok(stale.gh.calls.some(([m, p]) => m === 'DELETE' && p.endsWith('scaffold%3Atest-change-approved')));
  const fresh = await run({ labels: ['scaffold:test-change-approved'], events: [applied('alice', '2026-11-20T13:00:00Z')], action: 'synchronize' });
  assert.equal(fresh.ok, true, 'label applied after the push stays');
});

test('approved scenarios map tags to step hashes, and are empty unless approved', async () => {
  const { approvedScenarios } = await import('../lib/scenarios.mjs');
  const { SCENARIOS_MARKER } = await import('../lib/gherkin.mjs');
  const text = tagScenarios('Feature: f\n  Scenario: a\n    Given x', 7).text;
  const gh = (events) => fakeGh({
    '/repos/o/r/issues/7/comments': [{ user: { login: 'github-actions[bot]' }, body: `${SCENARIOS_MARKER}\n\`\`\`gherkin\n${text}\n\`\`\``, updated_at: '2026-01-01T00:00:00Z' }],
    '/repos/o/r/issues/7/events': events,
    '/repos/o/r/issues/7': { number: 7, user: { login: 'carol' }, labels: [] },
  });
  const config = configFrom(`approvers: [alice]\ngherkin: auto\nbdd:\n  workflow: ci.yml\n  artifact: r`);
  const ok = await approvedScenarios(gh([{ id: 1, event: 'labeled', label: { name: 'scaffold:gherkin-approved' }, actor: { login: 'alice', type: 'User' }, created_at: '2026-01-02T00:00:00Z' }]), 'o/r', 7, config);
  assert.deepEqual([...ok.map.keys()], ['@scaffold-7-S1']);
  assert.equal((await approvedScenarios(gh([]), 'o/r', 7, config)).map.size, 0);
  assert.equal((await approvedScenarios(gh([]), 'o/r', undefined, config)).map.size, 0);
});

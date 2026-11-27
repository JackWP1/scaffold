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

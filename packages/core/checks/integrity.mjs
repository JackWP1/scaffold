// Test integrity (PLAN.md section 6): flags removed or skipped tests, removed assertions, and changed or
// removed scenarios in existing `.feature` files unless the issue's approved scenarios include the change.
// Heuristic, from the diff: a finding needs a listed approver to apply scaffold:test-change-approved.
// Coverage isn't measured yet (no coverage data reaches the check).
import { matchesAny, patchLines } from '../lib/pr.mjs';
import { parseGherkin, scenarioHash } from '../lib/gherkin.mjs';

export const TEST_GLOBS = ['**/test/**', '**/tests/**', '**/__tests__/**', '*.test.*', '*.spec.*', '*_test.*', 'test_*.py', '*Test.java', '*Tests.java', '*Tests.cs'];
const isTest = (path) => matchesAny(path, TEST_GLOBS) && !path.startsWith('docs/');
const isFeature = (path) => path.endsWith('.feature');

// A test declaration, skipped or not: turning `it(` into `it.skip(` is a skip, not a deletion.
const DECL = /\b[xf]?(?:it|test|describe|context)(?:\.(?:skip|only|todo|each\s*\([^)]*\)))?\s*\(|^\s*(?:async\s+)?def\s+test_|^\s*func\s+Test\w*\(|@Test\b|\[(?:Fact|Test|Theory)\]/;
const SKIP = /\b(?:it|test|describe|context)\.(?:skip|todo|only)\s*\(|\bx(?:it|describe|test|context)\s*\(|\bf(?:it|describe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.skip\s*\(|\bunittest\.skip|\bt\.Skip(?:Now|f)?\s*\(|@(?:Disabled|Ignore)\b|\[Ignore\]|\bskip\s*:\s*true\b/;
const ASSERT = /\b(?:expect|assert\w*)\s*[.(]|^\s*assert\s|\bself\.assert\w*\s*\(|\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(|\.should\b|\bAssert\.\w+\s*\(/;

const count = (lines, re) => lines.filter((l) => re.test(l)).length;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Findings in test files, from the patch only. Pure.
export function testFindings(files) {
  const findings = [];
  for (const f of files) {
    const was = f.previous_filename ?? f.filename;
    if (!isTest(was) && !isTest(f.filename)) continue;
    if (f.status === 'removed') { findings.push(`\`${f.filename}\`: test file deleted`); continue; }
    if (isTest(was) && !isTest(f.filename)) { findings.push(`\`${was}\`: moved out of the test paths to \`${f.filename}\``); continue; }
    // GitHub omits the patch of a large diff: fail closed on any change it hides, added lines included.
    if (f.patch === undefined) {
      if (f.additions || f.deletions) findings.push(`\`${f.filename}\`: diff too large to check`);
      continue;
    }
    const { added, removed } = patchLines(f.patch);
    const fewer = count(removed, DECL) - count(added, DECL);
    if (fewer > 0) findings.push(`\`${f.filename}\`: ${plural(fewer, 'fewer test')}`);
    const skips = count(added, SKIP) - count(removed, SKIP);
    if (skips > 0) findings.push(`\`${f.filename}\`: ${plural(skips, 'test')} skipped, focused or left to do`);
    const asserts = count(removed, ASSERT) - count(added, ASSERT);
    if (asserts > 0) findings.push(`\`${f.filename}\`: ${plural(asserts, 'fewer assertion')}`);
  }
  return findings;
}

// Key for matching a scenario across versions: its SCAFFOLD tag if it has one, else its name.
const keyOf = (s) => s.tags.find((t) => /^@scaffold-\d+-S\d+$/.test(t)) ?? `name:${s.name}`;

// Changed or removed scenarios in existing feature files. `read(path, ref)` returns file text or null;
// `approved` maps an approved scenario's tag to its hash for the PR's linked issue (empty if none).
// A changed scenario is allowed only when it carries one of those tags and now matches the approved text.
export async function featureFindings(files, { read, baseRef, headRef, approved }) {
  const findings = [];
  for (const f of files) {
    const was = f.previous_filename ?? f.filename;
    if (!isFeature(was) || f.status === 'added') continue;
    const base = parseGherkin((await read(was, baseRef)) ?? '');
    const head = f.status === 'removed' || !isFeature(f.filename) ? { scenarios: [] } : parseGherkin((await read(f.filename, headRef)) ?? '');
    const now = new Map(head.scenarios.map((s) => [keyOf(s), s]));
    for (const s of base.scenarios) {
      const after = now.get(keyOf(s));
      if (after && scenarioHash(after) === scenarioHash(s)) continue;
      const tag = keyOf(s);
      if (after && approved.get(tag) === scenarioHash(after)) continue;
      findings.push(`\`${was}\`: scenario "${s.name.replace(/[`"]/g, '')}" ${after ? 'changed' : 'removed'}${tag.startsWith('@') ? '' : ' (no SCAFFOLD tag)'} and not in the approved scenarios`);
    }
  }
  return findings;
}

// The scenarios check (PLAN.md section 6, baseline): if the linked issue needs scenarios, they must be
// approved; the PR's scenarios must match the approved text and the plan's mapping; and the BDD runner
// report must show each of them ran and passed on the PR's head SHA.
//
// Which PR in the stack this is comes from the scenarios it adds: they must be exactly one sub-task's
// list in the plan. The top of the stack (and a one-PR plan) must hold the full approved set.
import { readRepoFile } from '../lib/config.mjs';
import { linkedIssues, prFiles } from '../lib/pr.mjs';
import { parseGherkin, scenarioHash } from '../lib/gherkin.mjs';
import { issueSteps } from '../lib/issue.mjs';
import { approvedScenarios, scenariosRequired } from '../lib/scenarios.mjs';
import { bddReport } from './bdd.mjs';

// The plan package's marked comment and its data (handover contract, PLAN.md section 5): read, never imported.
const PLAN_MARKER = '<!-- scaffold:plan -->';
const PLAN_DATA = /<!-- scaffold:plan-data ([A-Za-z0-9+/=]+) -->/;

export function planMapping(body) {
  try {
    const plan = JSON.parse(Buffer.from(body.match(PLAN_DATA)[1], 'base64').toString('utf8'));
    return { split: plan.split, subtasks: plan.subtasks.map((t) => ({ id: t.id, scenarios: (t.scenarios ?? []).slice().sort() })) };
  } catch {
    return null;
  }
}

// Scenarios in the feature files at `ref`: `tags` maps each of `issue`'s tags to [hash, …] (a tag may
// appear more than once); `untagged` lists the others as `path: name`.
async function scenariosAt(gh, repo, ref, paths, issue) {
  const tags = new Map();
  const untagged = new Set();
  const prefix = `@scaffold-${issue}-S`;
  for (const path of paths) {
    const { scenarios } = parseGherkin((await readRepoFile(gh, repo, path, ref)) ?? '');
    for (const s of scenarios) {
      const mine = s.tags.filter((x) => x.startsWith(prefix));
      for (const t of mine) tags.set(t, [...(tags.get(t) ?? []), scenarioHash(s)]);
      if (!mine.length) untagged.add(`${path}: ${s.name}`);
    }
  }
  return { tags, untagged };
}

// Feature files in the repo at `ref` (from the git tree). Over MAX_FEATURES fails the check rather
// than skipping files, so nothing escapes it.
export const MAX_FEATURES = 500;
async function featurePaths(gh, repo, ref) {
  const { tree = [], truncated } = await gh.get(`/repos/${repo}/git/trees/${ref}?recursive=1`);
  const paths = tree.filter((t) => t.type === 'blob' && t.path.endsWith('.feature')).map((t) => t.path);
  return { paths, truncated: truncated || paths.length > MAX_FEATURES };
}

const byNumber = (list) => [...list].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const ids = (tags) => byNumber([...tags].map((t) => t.replace(/^@scaffold-\d+-/, '')));

export async function scenariosCheck({ gh, repo, pr, config, report = bddReport }) {
  const ok = (outcome, details = []) => ({ ok: true, outcome, details });
  const fail = (outcome, details = []) => ({ ok: false, outcome, details });
  if (config.gherkin === 'off') return ok('scenarios off (`gherkin: off`)');
  const issue = linkedIssues(pr.body)[0];
  if (!issue) {
    return config.gherkin === 'always'
      ? fail('the PR doesn\'t link an issue: add "Fixes #<issue>" to its description (`gherkin: always`)')
      : ok('no linked issue: scenarios not required (`gherkin: auto`)');
  }
  const meta = await gh.get(`/repos/${repo}/issues/${issue}`);
  const labels = meta.labels.map((l) => l.name);
  const steps = issueSteps(gh, repo, issue, labels);
  if (!scenariosRequired(config, labels, config.gherkin === 'auto' ? await steps.events() : [])) return ok(`#${issue} doesn't need scenarios`);
  const approved = await approvedScenarios(gh, repo, issue, config);
  if (!approved.ok) return fail(`#${issue}'s scenarios aren't approved: ${approved.reason}`);

  // Scenarios at the head, and those new in this PR (not at its base, which for a stacked PR is the PR below).
  const { paths: headPaths, truncated } = await featurePaths(gh, repo, pr.head.sha);
  if (truncated) return fail(`the repo has too many files to check its feature files (more than ${MAX_FEATURES} \`.feature\` files, or a truncated tree)`);
  const { tags: head } = await scenariosAt(gh, repo, pr.head.sha, headPaths, issue);
  const { files } = await prFiles(gh, repo, pr.number);
  const features = files.filter((f) => f.filename.endsWith('.feature') && f.status !== 'removed');
  const base = await scenariosAt(gh, repo, pr.base.sha, features.map((f) => f.previous_filename ?? f.filename), issue);
  const touched = await scenariosAt(gh, repo, pr.head.sha, features.map((f) => f.filename), issue);
  // Untagged scenarios this PR adds aren't approved: every new scenario must be one of the issue's.
  const baseNames = new Set([...base.untagged].map((u) => u.replace(/^[^:]*: /, '')));

  const problems = [];
  for (const [tag, hashes] of head) {
    if (!approved.map.has(tag)) problems.push(`\`${tag}\` isn't an approved scenario of #${issue}`);
    else if (hashes.some((h) => h !== approved.map.get(tag))) problems.push(`\`${tag}\` doesn't match the approved text`);
    if (hashes.length > 1) problems.push(`\`${tag}\` is used by more than one scenario`);
  }
  for (const u of touched.untagged) {
    if (!baseNames.has(u.replace(/^[^:]*: /, ''))) problems.push(`new scenario \`${u.replace(/`/g, '')}\` has no \`@scaffold-${issue}-S<n>\` tag: only approved scenarios can be added`);
  }
  const added = [...touched.tags.keys()].filter((t) => !base.tags.has(t));
  const plan = (await steps.findComments(PLAN_MARKER)).map((c) => planMapping(c.body)).find(Boolean);
  const all = [...approved.map.keys()];
  let expected;
  let top;
  if (!plan || plan.split !== 'stack') {
    expected = all;
    top = true;
  } else {
    const got = ids(added).join(',');
    const sub = plan.subtasks.find((t) => byNumber(t.scenarios).join(',') === got);
    if (!sub) problems.push(`the scenarios this PR adds (${got || 'none'}) aren't one PR's list in the plan: ${plan.subtasks.map((t) => `${t.id}: ${t.scenarios.join(', ') || 'none'}`).join('; ')}`);
    top = sub?.id === plan.subtasks.at(-1).id;
    expected = top ? all : added;
  }
  for (const tag of expected) if (!head.has(tag)) problems.push(`\`${tag}\` is missing${top ? ' (the top of the stack needs every approved scenario)' : ''}`);
  if (problems.length) return fail(`${problems.length} scenario problem${problems.length === 1 ? '' : 's'}`, problems.map((p) => `- ${p}`));

  const { results, error } = await report(gh, repo, { bdd: config.bdd, sha: pr.head.sha });
  if (error) return fail(error);
  const notPassed = expected.filter((t) => results.get(t) !== 'passed');
  if (notPassed.length) {
    return fail(`${notPassed.length} scenario${notPassed.length === 1 ? '' : 's'} didn't run and pass on ${pr.head.sha.slice(0, 7)}`, notPassed.map((t) => `- \`${t}\`: ${results.get(t) ?? 'not in the report'}`));
  }
  return ok(`${expected.length} scenario${expected.length === 1 ? '' : 's'} of #${issue} (${ids(expected).join(', ')}) match the approved text and passed${top ? '' : ' (this PR\'s part of the stack)'}`);
}

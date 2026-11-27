// The review gate, automatic rework and circuit breaker (PLAN.md section 6), with the client injected so
// tests can fake it. No model call.
//
// The gate waits for the PR's other check runs on the head commit. If any fail on a Copilot PR, it posts
// one `@copilot` comment listing them (a rework round, no human approval); after `max_rework_rounds`
// rounds it applies scaffold:escalate and hands the PR to human review. On a pass it requests review from
// the developers assigned to the linked issue. Whether Copilot acts on comments from github-actions[bot]
// is a Phase 0 question (PLAN.md section 11); if it doesn't, the assigning developer prompts each round.
import { issueSteps } from '../core/lib/issue.mjs';
import { linkedIssues } from '../core/lib/pr.mjs';
import { escapeForComment } from '../core/lib/text.mjs';

export const COPILOT = ['Copilot', 'copilot-swe-agent[bot]'];
export const ESCALATE = 'scaffold:escalate';
const REWORK = '<!-- scaffold:rework';
const BOT = 'github-actions[bot]';
// SCAFFOLD's own PR checks: the gate waits until each has reported, so it can't pass before CI starts.
export const SCAFFOLD_CHECKS = ['scaffold-config-guard', 'scaffold-protected-paths', 'scaffold-hard-size', 'scaffold-test-integrity', 'scaffold-scenarios', 'scaffold-plan-gate', 'scaffold-pr-size'];
// Jobs that aren't checks of the PR: the gate itself and the status writer.
const IGNORED = ['scaffold-review-gate', 'status'];
const PASSING = ['success', 'neutral', 'skipped'];

const short = (name) => name.split(' / ').at(-1);

// The other check runs on `sha`, once all are complete and SCAFFOLD's have all reported.
// Returns { runs } or { pending: [names] } after `waitMs`.
export async function waitForChecks(gh, repo, sha, { waitMs = 40 * 60_000, pollMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let waited = 0; ; waited += pollMs) {
    const runs = [];
    for await (const page of pagesOf(gh, `/repos/${repo}/commits/${sha}/check-runs`)) runs.push(...page);
    const others = runs.filter((r) => !IGNORED.includes(short(r.name)));
    // A re-run leaves the old run in the list: keep the latest per name. Ids only grow, and a queued
    // re-run has an id before it has a start time.
    const latest = [...new Map(others.sort((a, b) => a.id - b.id).map((r) => [r.name, r])).values()];
    const missing = SCAFFOLD_CHECKS.filter((c) => !latest.some((r) => short(r.name) === c));
    const running = latest.filter((r) => r.status !== 'completed').map((r) => r.name);
    if (!missing.length && !running.length) return { runs: latest };
    if (waited >= waitMs) return { pending: [...running, ...missing] };
    await sleep(pollMs);
  }
}

// The check-runs endpoint wraps its list: { check_runs: [...] }.
async function* pagesOf(gh, path) {
  for (let page = 1; ; page++) {
    const { check_runs: items = [] } = await gh.get(`${path}?per_page=100&page=${page}`);
    yield items;
    if (items.length < 100) return;
  }
}

const reworkComments = async (gh, repo, number) => {
  const found = [];
  for await (const page of gh.pages(`/repos/${repo}/issues/${number}/comments`)) found.push(...page.filter((c) => c.user?.login === BOT && c.body?.startsWith(REWORK)));
  return found;
};

// Developers to request review from: the linked issue's assignees, not Copilot.
async function reviewers(gh, repo, pr) {
  const issue = linkedIssues(pr.body)[0];
  if (!issue) return [];
  const { assignees = [] } = await gh.get(`/repos/${repo}/issues/${issue}`);
  return assignees.map((a) => a.login).filter((l) => !COPILOT.includes(l) && l !== pr.user?.login);
}

async function requestReview(gh, repo, pr) {
  const who = await reviewers(gh, repo, pr);
  if (who.length) await gh.post(`/repos/${repo}/pulls/${pr.number}/requested_reviewers`, { reviewers: who });
  return who;
}

// Returns { ok, outcome, details, rows } where rows are the PR status comment's Review gate and Rework rows.
export async function reviewGate({ gh, repo, pr, config, wait = {} }) {
  const max = config.max_rework_rounds;
  const labels = (await gh.get(`/repos/${repo}/issues/${pr.number}`)).labels.map((l) => l.name);
  const rounds = await reworkComments(gh, repo, pr.number);
  const roundsRow = (extra = '') => `${rounds.length} of ${max} rounds${extra}`;
  const { runs, pending } = await waitForChecks(gh, repo, pr.head.sha, wait);
  if (pending) {
    return { ok: false, outcome: `checks still running or not started: ${pending.join(', ')}: re-run this check when they finish`, details: [], rows: { 'Review gate': '⏳ waiting for checks', Rework: roundsRow() } };
  }
  const failing = runs.filter((r) => !PASSING.includes(r.conclusion));
  const listed = failing.map((r) => `- **${escapeForComment(r.name)}**: ${r.conclusion}${r.output?.title ? `: ${escapeForComment(r.output.title).slice(0, 200)}` : ''}`);
  const ask = async (why) => {
    const who = await requestReview(gh, repo, pr);
    return who.length ? `${why}; review requested from ${who.map((w) => `\`${w}\``).join(', ')}` : `${why}; no assigned developer to request review from: CODEOWNERS applies`;
  };

  if (!failing.length) {
    const outcome = await ask('ready for human review: every check passed');
    return { ok: true, outcome, details: [], rows: { 'Review gate': '✅ ready for human review', Rework: roundsRow() } };
  }
  if (labels.includes(ESCALATE)) {
    return { ok: true, outcome: 'circuit breaker tripped (`scaffold:escalate`): human review, checks still failing', details: listed, rows: { 'Review gate': '🚨 escalated: human review', Rework: roundsRow(', circuit breaker tripped') } };
  }
  const fail = (outcome, rework) => ({ ok: false, outcome, details: listed, rows: { 'Review gate': `❌ ${failing.length} check${failing.length === 1 ? '' : 's'} failing`, Rework: rework } });
  if (!COPILOT.includes(pr.user?.login)) return fail(`${failing.length} failing check${failing.length === 1 ? '' : 's'}`, roundsRow(' (not a Copilot PR: no automatic rework)'));
  if (rounds.some((c) => c.body.startsWith(`${REWORK} ${pr.head.sha} -->`))) return fail('rework already asked for this commit: waiting for Copilot to push', roundsRow());

  if (rounds.length >= max) {
    await issueSteps(gh, repo, pr.number, labels).setLabels([ESCALATE], []);
    const oversized = failing.some((r) => short(r.name) === 'scaffold-pr-size');
    const outcome = await ask(`circuit breaker: ${max} rework rounds used, \`${ESCALATE}\` applied${oversized ? '; over the soft size limit, so a listed approver decides on `scaffold:size-exception`' : ''}`);
    return { ok: true, outcome, details: listed, rows: { 'Review gate': '🚨 escalated: human review', Rework: roundsRow(', circuit breaker tripped') } };
  }

  const n = rounds.length + 1;
  const split = failing.some((r) => short(r.name) === 'scaffold-pr-size')
    ? ['', `The PR is over the soft size limit (${config.pr_size.soft.files} files / ${config.pr_size.soft.lines} lines, exempt files not counted). Split it into a stack of PRs, each within the limit and no more than ${config.max_stack_prs} in all.`]
    : [];
  await gh.post(`/repos/${repo}/issues/${pr.number}/comments`, {
    body: [`${REWORK} ${pr.head.sha} -->`, `@copilot Rework round ${n} of ${max}: these checks failed on ${pr.head.sha.slice(0, 7)}. Fix them and push.`, '', ...listed, ...split].join('\n'),
  });
  return fail(`${failing.length} failing check${failing.length === 1 ? '' : 's'}: rework round ${n} of ${max} asked`, `${n} of ${max} rounds`);
}

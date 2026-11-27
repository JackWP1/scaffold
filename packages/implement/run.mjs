// Runs the implement package's PR checks and writes the PR status comment (PLAN.md sections 6 and 8).
// Config is read from the PR's base commit, so a PR can't loosen what it is checked against; an invalid
// file fails closed. The checks run as parallel jobs, so one job after them writes the status rows.
import { tryLoadConfig } from '../core/lib/config.mjs';
import { escapeForComment } from '../core/lib/text.mjs';
import { prFiles } from '../core/lib/pr.mjs';
import { issueSteps } from '../core/lib/issue.mjs';
import { MARKER, setGates } from '../core/lib/status.mjs';
import { planGate, sizeCheck, SIZE_COMMAND, SIZE_EXCEPTION } from './checks.mjs';
import { reviewGate, COPILOT } from './review.mjs';

export const PR_GATES = ['Plan gate', 'Size', 'Review gate', 'Rework', 'Work in progress'];
export const CHECKS = { 'scaffold-plan-gate': planGate, 'scaffold-pr-size': sizeCheck, 'scaffold-review-gate': reviewGate };
// Rows the status job writes from the parallel checks' outputs. The review gate writes its own rows:
// it waits for the others, so it finishes last.
export const ROWS = { 'scaffold-plan-gate': 'Plan gate', 'scaffold-pr-size': 'Size' };

// Advisory work-in-progress limit (PLAN.md section 8): open Copilot PRs per assigned developer.
export async function workInProgress(gh, repo, pr, config) {
  if (!COPILOT.includes(pr.user?.login)) return '➖ not a Copilot PR';
  const devs = (pr.assignees ?? []).map((a) => a.login).filter((l) => !COPILOT.includes(l));
  if (!devs.length) return '➖ no developer assigned';
  const counts = Object.fromEntries(devs.map((d) => [d, 0]));
  for await (const page of gh.pages(`/repos/${repo}/pulls?state=open`)) {
    for (const p of page) {
      if (!COPILOT.includes(p.user?.login)) continue;
      for (const a of p.assignees ?? []) if (a.login in counts) counts[a.login]++;
    }
  }
  const warn = config.warn_open_prs_per_developer;
  const list = (ds) => ds.map((d) => `\`${d}\`: ${counts[d]}`).join(', ');
  const over = devs.filter((d) => counts[d] > warn);
  return over.length
    ? `⚠️ open Copilot PRs: ${list(over)} (advisory: \`warn_open_prs_per_developer\` is ${warn})`
    : `✅ open Copilot PRs: ${list(devs)}`;
}

// Returns { ok, outcome, row, lines }.
export async function runImplementCheck(gh, repo, { check, pr, wait }) {
  const lines = (r) => [`### ${check}`, `${r.ok ? '✅' : '❌'} ${r.outcome}`, ...(r.details?.length ? ['', ...r.details] : [])];
  const { config, configError } = await tryLoadConfig(gh, repo, pr.base.sha);
  if (configError) {
    const r = { ok: false, outcome: `\`.github/scaffold-config.yml\` on the base branch is invalid: ${escapeForComment(configError)}`, row: '⛔ `.github/scaffold-config.yml` is invalid' };
    return { ...r, lines: lines(r) };
  }
  const { files, truncated } = check === 'scaffold-pr-size' ? await prFiles(gh, repo, pr.number) : {};
  const r = await CHECKS[check]({ gh, repo, pr, files, truncated, config, wait });
  if (r.rows) {
    const { findComment, upsertStatus } = issueSteps(gh, repo, pr.number, []);
    await upsertStatus(setGates((await findComment(MARKER))?.body, r.rows, undefined, PR_GATES));
  }
  return { ...r, lines: lines(r) };
}

// Writes the rows the check jobs reported (`rows`: gate → state; a missing row means the job didn't finish).
export async function writeStatus(gh, repo, { pr, rows }) {
  const { findComment, upsertStatus } = issueSteps(gh, repo, pr.number, []);
  const states = Object.fromEntries(Object.entries(ROWS).map(([, gate]) => [gate, rows[gate] || '⚠️ check didn\'t finish: re-run it']));
  const failing = Object.entries(states).filter(([, s]) => !s.startsWith('✅')).map(([g]) => g);
  const { config } = await tryLoadConfig(gh, repo, pr.base.sha);
  if (config) states['Work in progress'] = await workInProgress(gh, repo, pr, config);
  const next = failing.length
    ? `fix the failing rows (${failing.join(', ')}); the checks re-run on each push.`
    : 'the review gate requests human review once every check has passed.';
  await upsertStatus(setGates((await findComment(MARKER))?.body, states, next, PR_GATES));
  return states;
}

const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];

// `/size-exception <reason>` on a PR: records the request in the Size row for a listed approver.
export async function runSizeCommand(gh, repo, { event, config, configError }) {
  const comment = event.comment;
  if (!event.issue?.pull_request) return { skip: 'not a pull request' };
  const m = comment?.body?.trim().match(SIZE_COMMAND);
  if (event.action !== 'created' || !m) return { skip: 'comment is not /size-exception' };
  const react = (content) => gh.post(`/repos/${repo}/issues/comments/${comment.id}/reactions`, { content });
  if (!TRUSTED.includes(comment.author_association) || comment.user?.type !== 'User') {
    await react('confused');
    return { skip: '/size-exception: members only' };
  }
  const reason = m[1]?.trim();
  if (!reason) {
    await react('confused');
    return { skip: '/size-exception needs a reason' };
  }
  await react('eyes');
  const { findComment, upsertStatus } = issueSteps(gh, repo, event.issue.number, []);
  const approvers = configError ? '' : config.approvers.map((a) => `\`${a}\``).join(', ');
  const who = escapeForComment(comment.user.login);
  const why = escapeForComment(reason).slice(0, 200).replace(/\s+/g, ' ').replaceAll('|', '\\|');
  await upsertStatus(setGates(
    (await findComment(MARKER))?.body,
    { Size: `⏳ exception requested by \`${who}\`: ${why}` },
    `a listed approver${approvers ? ` (${approvers})` : ''} who isn't the PR author decides, and applies \`${SIZE_EXCEPTION}\` to grant it.`,
    PR_GATES,
  ));
  return { lines: ['### SCAFFOLD /size-exception', `Requested by ${who}: ${why}`] };
}

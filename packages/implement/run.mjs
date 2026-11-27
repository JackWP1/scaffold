// Runs the implement package's PR checks and writes the PR status comment (PLAN.md sections 6 and 8).
// Config is read from the PR's base commit, so a PR can't loosen what it is checked against; an invalid
// file fails closed. The checks run as parallel jobs, so one job after them writes the status rows.
import { tryLoadConfig } from '../core/lib/config.mjs';
import { escapeForComment } from '../core/lib/text.mjs';
import { prFiles } from '../core/lib/pr.mjs';
import { issueSteps } from '../core/lib/issue.mjs';
import { MARKER, setGates } from '../core/lib/status.mjs';
import { planGate, sizeCheck, SIZE_COMMAND, SIZE_EXCEPTION } from './checks.mjs';

export const PR_GATES = ['Plan gate', 'Size', 'Review gate', 'Rework'];
export const CHECKS = { 'scaffold-plan-gate': planGate, 'scaffold-pr-size': sizeCheck };
export const ROWS = { 'scaffold-plan-gate': 'Plan gate', 'scaffold-pr-size': 'Size' };

// Returns { ok, outcome, row, lines }.
export async function runImplementCheck(gh, repo, { check, pr }) {
  const lines = (r) => [`### ${check}`, `${r.ok ? '✅' : '❌'} ${r.outcome}`, ...(r.details?.length ? ['', ...r.details] : [])];
  const { config, configError } = await tryLoadConfig(gh, repo, pr.base.sha);
  if (configError) {
    const r = { ok: false, outcome: `\`.github/scaffold-config.yml\` on the base branch is invalid: ${escapeForComment(configError)}`, row: '⛔ `.github/scaffold-config.yml` is invalid' };
    return { ...r, lines: lines(r) };
  }
  const { files, truncated } = check === 'scaffold-pr-size' ? await prFiles(gh, repo, pr.number) : {};
  const r = await CHECKS[check]({ gh, repo, pr, files, truncated, config });
  return { ...r, lines: lines(r) };
}

// Writes the rows the check jobs reported (`rows`: gate → state; a missing row means the job didn't finish).
export async function writeStatus(gh, repo, { pr, rows }) {
  const { findComment, upsertStatus } = issueSteps(gh, repo, pr.number, []);
  const states = Object.fromEntries(Object.entries(ROWS).map(([, gate]) => [gate, rows[gate] || '⚠️ check didn\'t finish: re-run it']));
  const failing = Object.entries(states).filter(([, s]) => !s.startsWith('✅')).map(([g]) => g);
  const next = failing.length ? `fix the failing rows (${failing.join(', ')}); the checks re-run on each push.` : 'the review gate runs once CI has finished (coming in this slice).';
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

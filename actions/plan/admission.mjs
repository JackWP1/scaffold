// `/plan` admission (PLAN.md section 8). Runs in one repo-wide concurrency group, so the in-flight
// count and the scaffold:planned reservation can't interleave across issues.
//
// GitHub keeps only one waiting run per concurrency group and cancels the older one, so a burst of
// `/plan` comments can drop a run. Each admit run therefore sweeps recent `/plan` comments that
// SCAFFOLD hasn't reacted to. The reaction is the "handled" mark: it is written inside the group.
import { issueSteps } from '../lib/issue.mjs';
import { MARKER, setGates } from '../lib/status.mjs';
import { escapeForComment } from '../lib/text.mjs';

const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const PLANNABLE = ['scaffold:ready', 'scaffold:planned', 'scaffold:plan-approved'];
const IN_FLIGHT = ['scaffold:planned', 'scaffold:plan-approved'];
const BOT = 'github-actions[bot]';
export const SWEEP_MS = 60 * 60 * 1000;

export const isPlanCommand = (body) => /^\/plan(\s|$)/.test(body ?? '');

async function handled(gh, repo, comment) {
  for await (const page of gh.pages(`/repos/${repo}/issues/comments/${comment.id}/reactions`)) {
    if (page.some((r) => r.user?.login === BOT)) return true;
  }
  return false;
}

// Open issues in flight, not counting `exclude`. Sub-tickets carry no lifecycle label.
export async function inFlight(gh, repo, exclude) {
  const numbers = new Set();
  for (const label of IN_FLIGHT) {
    for await (const page of gh.pages(`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`)) {
      for (const i of page) if (!i.pull_request && i.number !== exclude) numbers.add(i.number);
    }
  }
  return numbers.size;
}

// Admits one `/plan` comment: reacts 👀 and reserves the slot by applying scaffold:planned, or
// reacts 😕. `configError` is set when .github/scaffold-config.yml is invalid, which blocks planning.
// Returns { outcome: 'admitted' | 'refused' | 'skipped', reason }.
export async function admit(gh, repo, { issue, comment, config, configError }) {
  if (issue.pull_request) return { outcome: 'skipped', reason: 'pull request' };
  if (!isPlanCommand(comment.body)) return { outcome: 'skipped', reason: 'comment is not /plan' };
  if (await handled(gh, repo, comment)) return { outcome: 'skipped', reason: 'already handled' };
  const react = (content) => gh.post(`/repos/${repo}/issues/comments/${comment.id}/reactions`, { content });
  const labels = issue.labels.map((l) => l.name);
  const { setLabels, findComment, upsertStatus } = issueSteps(gh, repo, issue.number, labels);
  const refuse = async (reason, plan, next) => {
    await react('confused');
    if (plan) await upsertStatus(setGates((await findComment(MARKER))?.body, { Plan: plan }, next));
    return { outcome: 'refused', reason };
  };

  if (!TRUSTED.includes(comment.author_association) || comment.user?.type !== 'User') {
    return refuse(`/plan by ${comment.author_association} ${comment.user?.type}: members only`);
  }
  if (!labels.some((l) => PLANNABLE.includes(l))) return refuse('issue is not scaffold:ready');
  if (configError) {
    return refuse(
      `invalid config: ${configError}`,
      `⛔ \`.github/scaffold-config.yml\` is invalid: ${escapeForComment(configError)}`,
      'fix `.github/scaffold-config.yml`, then comment `/plan` again.',
    );
  }
  const count = await inFlight(gh, repo, issue.number);
  if (count >= config.max_in_flight) {
    return refuse(
      `${count} of ${config.max_in_flight} tickets in flight`,
      `⏸️ waiting: ${count} of ${config.max_in_flight} tickets in flight`,
      'wait for a ticket to merge or close, then comment `/plan` again.',
    );
  }
  await react('eyes');
  // Reserve the slot; a new plan also withdraws any approval of the old one.
  await setLabels(['scaffold:planned'], ['scaffold:ready', 'scaffold:plan-approved']);
  return { outcome: 'admitted', reason: `${count + 1} of ${config.max_in_flight} in flight` };
}

// `/plan` comments created since `since`, oldest first. admit() skips any already handled.
export async function recentPlanComments(gh, repo, since) {
  const found = [];
  for await (const page of gh.pages(`/repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc`)) {
    for (const c of page) if (isPlanCommand(c.body) && Date.parse(c.created_at) >= Date.parse(since)) found.push(c);
  }
  return found;
}

export const issueNumber = (comment) => Number(comment.issue_url.split('/').pop());

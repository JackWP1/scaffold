// The implement package's PR checks (PLAN.md section 6), with the client injected so tests can fake it.
// Imports only from core (PLAN.md section 5): plan approval and scenarios are re-checked on the issue
// timeline, not trusted from labels. No model call. Each returns { ok, outcome, details, row }, where
// `row` is the PR status comment's row for the check.
import { checkApproval } from '../core/lib/approval.mjs';
import { issueSteps, markedComments } from '../core/lib/issue.mjs';
import { stageOn } from '../core/lib/config.mjs';
import { linkedIssues, prSize } from '../core/lib/pr.mjs';
import { scenariosRequired, approvedScenarios } from '../core/lib/scenarios.mjs';
import { escapeForComment } from '../core/lib/text.mjs';

// The plan package's marked comment (handover contract, PLAN.md section 5): read, never imported.
const PLAN_MARKER = '<!-- scaffold:plan -->';
export const SIZE_EXCEPTION = 'scaffold:size-exception';
export const SIZE_COMMAND = /^\/size-exception(?:\s+([\s\S]*))?$/;
const EPOCH = '1970-01-01T00:00:00Z';

const result = (ok, outcome, row, details = []) => ({ ok, outcome, row, details });

// Plan gate: the linked issue has a valid scaffold:plan-approved. With plan on, the plan comment must be
// unchanged since; with plan off, only that a listed approver applied the label (packages/plan/HANDOFF.md).
// When scenarios are required they must still be approved.
export async function planGate({ gh, repo, pr, config }) {
  const issue = linkedIssues(pr.body)[0];
  if (!issue) return result(false, 'the PR doesn\'t link an issue: add "Fixes #<issue>" to its description', '❌ no linked issue');
  const meta = await gh.get(`/repos/${repo}/issues/${issue}`);
  const labels = meta.labels.map((l) => l.name);
  if (!labels.includes('scaffold:plan-approved')) return result(false, `#${issue} has no approved plan (\`scaffold:plan-approved\`)`, `❌ #${issue} has no approved plan`);
  const events = await issueSteps(gh, repo, issue, labels).events();
  const planOn = stageOn(config, 'plan');
  const plans = planOn ? await markedComments(gh, repo, issue, PLAN_MARKER) : [{ body: '', updated_at: EPOCH }];
  if (plans.length > 1) return result(false, `#${issue} has more than one comment marked as the plan`, '❌ more than one plan');
  const approval = checkApproval({
    events, label: 'scaffold:plan-approved', author: meta.user?.login, approvers: config.approvers,
    comment: plans[0], what: 'plan', missing: `#${issue} has no plan comment`,
  });
  if (!approval.ok) return result(false, `#${issue}'s plan approval isn't valid: ${approval.reason}`, `❌ #${issue}: ${approval.reason}`);
  if (scenariosRequired(config, labels, events)) {
    const scenarios = await approvedScenarios(gh, repo, issue, config);
    if (!scenarios.ok) return result(false, `#${issue}'s scenarios aren't approved: ${scenarios.reason}`, `❌ #${issue}: scenarios not approved`);
  }
  const how = planOn ? `plan \`${approval.hash}\`` : 'plan stage off: label checked only';
  return result(true, `#${issue}'s plan was approved by \`${approval.approver}\` (${how})`, `✅ #${issue}, approved by \`${approval.approver}\``);
}

const fmt = (s) => `${s.files} files / ${s.lines} lines`;

// The latest /size-exception reason on the PR from a member, or null.
async function exceptionReason(gh, repo, number) {
  let reason = null;
  for await (const page of gh.pages(`/repos/${repo}/issues/${number}/comments`)) {
    for (const c of page) {
      const m = c.body?.trim().match(SIZE_COMMAND);
      if (m && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association)) reason = m[1]?.trim() || null;
    }
  }
  return reason;
}

// PR size: within the soft limit, or a valid scaffold:size-exception (lifts the soft limit only; the
// hard limit is core's scaffold-hard-size). Limits from the base commit's config.
export async function sizeCheck({ gh, repo, pr, files, truncated, config }) {
  const size = prSize(files, config.pr_size.exempt);
  const { soft, hard } = config.pr_size;
  if (truncated || size.files > hard.files || size.lines > hard.lines) {
    return result(false, `${truncated ? 'more than 3000 files' : fmt(size)} is over the hard limit (${fmt(hard)}): split it`, `❌ ${fmt(size)}: over the hard limit, split it`);
  }
  if (size.files <= soft.files && size.lines <= soft.lines) return result(true, `${fmt(size)}, within the soft limit (${fmt(soft)})`, `✅ ${fmt(size)}`);
  const labels = (await gh.get(`/repos/${repo}/issues/${pr.number}`)).labels.map((l) => l.name);
  const over = `${fmt(size)} is over the soft limit (${fmt(soft)})`;
  const ask = 'Split it into a stack of PRs, or comment `/size-exception <reason>` and have a listed approver apply `scaffold:size-exception`.';
  if (!labels.includes(SIZE_EXCEPTION)) return result(false, over, `⚠️ ${over}`, [ask]);
  const approval = checkApproval({
    events: await issueSteps(gh, repo, pr.number, labels).events(), label: SIZE_EXCEPTION, author: pr.user?.login,
    approvers: config.approvers, comment: { body: '', updated_at: EPOCH }, what: 'size exception',
  });
  if (!approval.ok) return result(false, `${over}; \`${SIZE_EXCEPTION}\` isn't valid: ${approval.reason}`, `❌ ${over}; exception not valid`, [ask]);
  const reason = await exceptionReason(gh, repo, pr.number);
  const why = reason ? `: ${escapeForComment(reason).slice(0, 200).replace(/\s+/g, ' ').replaceAll('|', '\\|')}` : '';
  return result(true, `${over}; exception granted by \`${approval.approver}\`${why}`, `✅ ${fmt(size)}: exception by \`${approval.approver}\`${why}`);
}

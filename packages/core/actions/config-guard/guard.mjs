// scaffold-config-guard (PLAN.md section 4): a core check on every PR, with the client injected so tests
// can fake it. Validates .github/scaffold-config.yml at the PR head; a change to a protected setting
// needs an approving review of the head commit from an approver listed on the base branch (so a PR can't
// list itself) who isn't the PR author.
import { configFrom, readRepoFile, ConfigError, CONFIG_PATH, PROTECTED } from '../../lib/config.mjs';
import { escapeForComment } from '../../lib/text.mjs';

async function touchesConfig(gh, repo, number) {
  for await (const page of gh.pages(`/repos/${repo}/pulls/${number}/files`)) {
    if (page.some((f) => f.filename === CONFIG_PATH || f.previous_filename === CONFIG_PATH)) return true;
  }
  return false;
}

// Each reviewer's latest decision; comments don't change it.
async function latestReviews(gh, repo, number) {
  const latest = new Map();
  for await (const page of gh.pages(`/repos/${repo}/pulls/${number}/reviews`)) {
    for (const r of page) {
      if (r.user?.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user.login.toLowerCase(), r);
    }
  }
  return [...latest.values()];
}

// Returns { ok, outcome, lines }. `pr` is the event's pull_request.
export async function runGuard(gh, repo, { pr }) {
  const result = (ok, outcome, detail = []) => ({ ok, outcome, lines: ['### scaffold-config-guard', `${ok ? '✅' : '❌'} ${outcome}`, ...detail] });
  if (!(await touchesConfig(gh, repo, pr.number))) return result(true, `\`${CONFIG_PATH}\` is unchanged`);

  let head;
  try {
    head = configFrom((await readRepoFile(gh, repo, CONFIG_PATH, pr.head.sha)) ?? '');
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return result(false, `\`${CONFIG_PATH}\` is invalid: ${escapeForComment(err.message)}`);
  }
  let base = null;
  try {
    base = configFrom((await readRepoFile(gh, repo, CONFIG_PATH, pr.base.sha)) ?? '');
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
  }

  const changed = PROTECTED.filter((k) => JSON.stringify(base?.[k]) !== JSON.stringify(head[k]));
  if (!changed.length) return result(true, 'valid; no protected setting changed');
  const list = changed.map((k) => `\`${k}\``).join(', ');
  // First install, or a base file that never passed this check: nobody is listed to approve yet.
  if (!base?.approvers.length) {
    return result(true, `valid; changes ${list}. No approvers are listed on the base branch, so code-owner review is the only protection for this PR`);
  }

  const author = pr.user?.login?.toLowerCase();
  const approvals = (await latestReviews(gh, repo, pr.number))
    .filter((r) => r.state === 'APPROVED' && r.commit_id === pr.head.sha && r.user.type === 'User');
  const approver = approvals.find((r) => base.approvers.includes(r.user.login.toLowerCase()) && r.user.login.toLowerCase() !== author);
  if (approver) return result(true, `valid; changes ${list}, approved by \`${approver.user.login}\``);
  return result(false, `changes ${list}: needs an approving review of the latest commit from a listed approver who isn't the PR author`, [
    '',
    `Listed approvers (base branch): ${base.approvers.map((a) => `\`${a}\``).join(', ')}`,
  ]);
}

// Runs one baseline PR check (PLAN.md section 6), with the client injected so tests can fake it.
// Config is read from the PR's base commit, so a PR can't loosen the limits it is checked against;
// an invalid file fails closed.
import { tryLoadConfig, readRepoFile } from '../lib/config.mjs';
import { escapeForComment } from '../lib/text.mjs';
import { prFiles, linkedIssues } from '../lib/pr.mjs';
import { checkApproval } from '../lib/approval.mjs';
import { issueSteps } from '../lib/issue.mjs';
import { approvedScenarios } from '../lib/scenarios.mjs';
import { protectedPaths, hardSize } from './baseline.mjs';
import { testFindings, featureFindings } from './integrity.mjs';
import { scenariosCheck } from './scenarios.mjs';

export const TEST_CHANGE_APPROVED = 'scaffold:test-change-approved';

// Findings pass only with scaffold:test-change-approved from a listed approver who isn't the PR author.
// A push after the label withdraws it: the run for that push removes it (as a stale review is dismissed).
async function testIntegrity({ gh, repo, pr, files, config, event }) {
  const issue = linkedIssues(pr.body)[0];
  const { map: approved } = await approvedScenarios(gh, repo, issue, config);
  const read = (path, ref) => readRepoFile(gh, repo, path, ref);
  const findings = [...testFindings(files), ...await featureFindings(files, { read, baseRef: pr.base.sha, headRef: pr.head.sha, approved })];
  const listed = ['', ...findings.slice(0, 50).map((f) => `- ${escapeForComment(f)}`), ...(findings.length > 50 ? [`- … and ${findings.length - 50} more`] : []), '', 'Coverage is not checked yet.'];
  if (!findings.length) return { ok: true, outcome: 'no tests or assertions removed or skipped; no existing scenarios changed outside the approved ones', details: ['Coverage is not checked yet.'] };

  const current = await gh.get(`/repos/${repo}/issues/${pr.number}`);
  const labels = current.labels.map((l) => l.name);
  const ask = `A listed approver who isn't the PR author reviews these and applies \`${TEST_CHANGE_APPROVED}\`; a new push withdraws it.`;
  if (!labels.includes(TEST_CHANGE_APPROVED)) return { ok: false, outcome: `${findings.length} test integrity finding${findings.length === 1 ? '' : 's'}`, details: [ask, ...listed] };
  const steps = issueSteps(gh, repo, pr.number, labels);
  const events = await steps.events();
  const applied = events.filter((e) => e.event === 'labeled' && e.label?.name === TEST_CHANGE_APPROVED).at(-1);
  if (event?.action === 'synchronize' && (!applied || Date.parse(applied.created_at) < Date.parse(pr.updated_at))) {
    await steps.setLabels([], [TEST_CHANGE_APPROVED]);
    return { ok: false, outcome: `new commits since \`${TEST_CHANGE_APPROVED}\` was applied: label removed`, details: [ask, ...listed] };
  }
  const approval = checkApproval({
    events, label: TEST_CHANGE_APPROVED, author: pr.user?.login, approvers: config.approvers,
    comment: { body: pr.head.sha, updated_at: '1970-01-01T00:00:00Z' }, what: 'test changes',
  });
  if (!approval.ok) return { ok: false, outcome: `\`${TEST_CHANGE_APPROVED}\` not valid: ${approval.reason}`, details: [ask, ...listed] };
  return { ok: true, outcome: `${findings.length} finding${findings.length === 1 ? '' : 's'} approved by \`${approval.approver}\``, details: listed };
}

export const CHECKS = {
  'scaffold-protected-paths': async ({ files }) => protectedPaths(files),
  'scaffold-hard-size': async ({ files, truncated, config }) => hardSize(files, config.pr_size, { truncated }),
  'scaffold-test-integrity': testIntegrity,
  'scaffold-scenarios': scenariosCheck,
};
const NEEDS_CONFIG = ['scaffold-hard-size', 'scaffold-test-integrity', 'scaffold-scenarios'];

// Returns { ok, outcome, lines } for the job summary.
export async function runCheck(gh, repo, { check, pr, event }) {
  const result = (ok, outcome, details = []) => ({ ok, outcome, lines: [`### ${check}`, `${ok ? '✅' : '❌'} ${outcome}`, ...(details.length ? ['', ...details] : [])] });
  const run = CHECKS[check];
  if (!run) return result(false, `unknown check \`${check}\``);
  const { config, configError } = NEEDS_CONFIG.includes(check) ? await tryLoadConfig(gh, repo, pr.base.sha) : {};
  if (configError) return result(false, `\`.github/scaffold-config.yml\` on the base branch is invalid: ${escapeForComment(configError)}`);
  const { files, truncated } = check === 'scaffold-scenarios' ? {} : await prFiles(gh, repo, pr.number);
  const r = await run({ gh, repo, pr, files, truncated, config, event });
  return result(r.ok, r.outcome, r.details);
}

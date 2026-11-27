// Runs one baseline PR check (PLAN.md section 6), with the client injected so tests can fake it.
// Config is read from the PR's base commit, so a PR can't loosen the limits it is checked against;
// an invalid file fails closed.
import { tryLoadConfig } from '../lib/config.mjs';
import { escapeForComment } from '../lib/text.mjs';
import { prFiles } from '../lib/pr.mjs';
import { protectedPaths, hardSize } from './baseline.mjs';

export const CHECKS = {
  'scaffold-protected-paths': async ({ files }) => protectedPaths(files),
  'scaffold-hard-size': async ({ files, truncated, config }) => hardSize(files, config.pr_size, { truncated }),
};
const NEEDS_CONFIG = ['scaffold-hard-size'];

// Returns { ok, outcome, lines } for the job summary.
export async function runCheck(gh, repo, { check, pr }) {
  const result = (ok, outcome, details = []) => ({ ok, outcome, lines: [`### ${check}`, `${ok ? '✅' : '❌'} ${outcome}`, ...(details.length ? ['', ...details] : [])] });
  const run = CHECKS[check];
  if (!run) return result(false, `unknown check \`${check}\``);
  const { config, configError } = NEEDS_CONFIG.includes(check) ? await tryLoadConfig(gh, repo, pr.base.sha) : {};
  if (configError) return result(false, `\`.github/scaffold-config.yml\` on the base branch is invalid: ${escapeForComment(configError)}`);
  const { files, truncated } = await prFiles(gh, repo, pr.number);
  const r = await run({ gh, repo, pr, files, truncated, config });
  return result(r.ok, r.outcome, r.details);
}

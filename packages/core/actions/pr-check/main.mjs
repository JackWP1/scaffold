// Entry point for the baseline PR checks (logic in packages/core/checks/). Fails the job when the check fails.
import { readFile, appendFile } from 'node:fs/promises';
import { github } from '../../lib/github.mjs';
import { runCheck } from '../../checks/run.mjs';

const check = process.env.SCAFFOLD_CHECK;
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const summary = (lines) => appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${lines.join('\n')}\n`);

if (event.merge_group) {
  // In the merge queue: the PR passed this check to get here (PLAN.md section 8).
  await summary([`### ${check}`, '✅ merge queue: checked on the PR']);
} else if (!event.pull_request) {
  await summary([`### ${check}`, 'Skipped: not a pull request event']);
} else {
  const { ok, outcome, lines } = await runCheck(github(process.env.GITHUB_TOKEN), process.env.GITHUB_REPOSITORY, { check, pr: event.pull_request, event });
  await summary(lines);
  if (!ok) {
    console.log(`::error::${outcome}`);
    process.exitCode = 1;
  }
}

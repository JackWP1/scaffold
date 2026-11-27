// Entry point for the implement package's PR jobs (logic in packages/implement/run.mjs).
// SCAFFOLD_MODE: a check name (fails the job when the check fails), `status` or `size-command`.
import { readFile, appendFile } from 'node:fs/promises';
import { github } from '../../../core/lib/github.mjs';
import { tryLoadConfig } from '../../../core/lib/config.mjs';
import { runImplementCheck, writeStatus, runSizeCommand, CHECKS, ROWS } from '../../run.mjs';

const mode = process.env.SCAFFOLD_MODE;
const repo = process.env.GITHUB_REPOSITORY;
const gh = github(process.env.GITHUB_TOKEN);
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const summary = (lines) => appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${lines.join('\n')}\n`);

if (CHECKS[mode]) {
  if (event.merge_group) {
    await summary([`### ${mode}`, '✅ merge queue: a PR-only check, passed on the PR']);
  } else if (!event.pull_request) {
    await summary([`### ${mode}`, 'Skipped: not a pull request event']);
  } else {
    const r = await runImplementCheck(gh, repo, { check: mode, pr: event.pull_request });
    // The review gate writes its own rows (r.rows); the parallel checks pass theirs to the status job.
    if (r.row) await appendFile(process.env.GITHUB_OUTPUT ?? '/dev/null', `row=${r.row.replace(/\n/g, ' ')}\n`);
    await summary(r.lines);
    if (!r.ok) {
      console.log(`::error::${r.outcome}`);
      process.exitCode = 1;
    }
  }
} else if (mode === 'status') {
  const rows = Object.fromEntries(Object.entries(ROWS).map(([check, gate]) => [gate, process.env[`ROW_${check.replace(/-/g, '_').toUpperCase()}`]]));
  await writeStatus(gh, repo, { pr: event.pull_request, rows });
} else if (mode === 'size-command') {
  const { skip, lines } = await runSizeCommand(gh, repo, { event, ...await tryLoadConfig(gh, repo) });
  await summary(skip ? ['### SCAFFOLD /size-exception', `Skipped: ${skip}`] : lines);
} else {
  throw new Error(`unknown mode ${mode}`);
}

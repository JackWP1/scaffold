// Entry point for scaffold-config-guard (logic in guard.mjs). Fails the job when the guard fails.
import { readFile, appendFile } from 'node:fs/promises';
import { github } from '../../lib/github.mjs';
import { runGuard } from './guard.mjs';

const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const summary = (lines) => appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${lines.join('\n')}\n`);

if (!event.pull_request) {
  await summary(['### scaffold-config-guard', 'Skipped: not a pull request event']);
} else {
  const { ok, outcome, lines } = await runGuard(github(process.env.GITHUB_TOKEN), process.env.GITHUB_REPOSITORY, { pr: event.pull_request });
  await summary(lines);
  if (!ok) {
    console.log(`::error::${outcome}`);
    process.exitCode = 1;
  }
}

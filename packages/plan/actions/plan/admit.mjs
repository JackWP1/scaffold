// Entry point for the plan action's admit mode: admits this `/plan` and any dropped ones (admission.mjs).
// Outputs `admitted`: a JSON list of { issue, comment } for the plan job's matrix.
import { readFile, appendFile } from 'node:fs/promises';
import { github } from '../../../core/lib/github.mjs';
import { tryLoadConfig } from '../../../core/lib/config.mjs';
import { admit, recentPlanComments, issueNumber, SWEEP_MS } from '../../admission.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const gh = github(process.env.GITHUB_TOKEN);

async function main() {
  const { config, configError } = await tryLoadConfig(gh, repo);
  const admitted = [];
  const rows = [];
  async function handle(issue, comment, source) {
    const { outcome, reason } = await admit(gh, repo, { issue, comment, config, configError });
    rows.push(`| #${issue.number} | ${comment.id} | ${source} | ${outcome} | ${reason.replaceAll('|', '\\|')} |`);
    if (outcome === 'admitted') admitted.push({ issue: issue.number, comment: comment.id });
  }

  // Labels in the webhook payload can be stale by now, so every issue is fetched fresh.
  await handle(await gh.get(`/repos/${repo}/issues/${event.issue.number}`), event.comment, 'this run');
  for (const comment of await recentPlanComments(gh, repo, new Date(Date.now() - SWEEP_MS).toISOString())) {
    if (comment.id === event.comment.id) continue;
    try {
      await handle(await gh.get(`/repos/${repo}/issues/${issueNumber(comment)}`), comment, 'sweep');
    } catch (err) {
      console.log(`::warning::Sweep of comment ${comment.id} failed: ${err.message}`);
    }
  }

  await appendFile(process.env.GITHUB_OUTPUT ?? '/dev/null', `admitted=${JSON.stringify(admitted)}\n`);
  await appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', [
    '### SCAFFOLD plan admission',
    '| Issue | Comment | Source | Outcome | Reason |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n'));
}

await main();
